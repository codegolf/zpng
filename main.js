function makePNGStub(data, options) {
	var length = data.length;
	if (!length) {
		throw new TypeError('invalid data');
	}
	options = options || {
		// iterations: 15,
		// filter: 'none'
	};

	var filteredData = filterData(data, options.filter);

	var compressor = new Zopfli.Deflate(filteredData, {
		iterations: options.iterations
	});

	var compressedData = compressor.compress();

	var pngSignature = [
		0x89, 0x50, 0x4E, 0x47, 0xD, 0xA, 0x1A, 0xA, // PNG signature, never changes
	];

	var ihdrLength = [
		// IHDR, Image header
		0x00, 0x00, 0x00, 0x0D, // Length of IHDR chunk. Always 13 bytes
	];
	var ihdrContents = [
		0x49, 0x48, 0x44, 0x52, // ASCII: I, H, D, R

		(data.length >>> 24 & 255), (data.length >>> 16 & 255), (data.length >>> 8 & 255), (data.length >>> 0 & 255), // Image width, UInt32. Equals to data length (in this implementation)
		0x00, 0x00, 0x00, 0x01, // Image height, UInt32: Always 1 px (in this implementation)
		0x08, // Bit depth: 8 bit
		0x00, // Color type: 0, Greyscale
		0x00, // Compression method: 0. There are no values other than 0 defined in the spec.
		0x00, // Filter method: 0. Again, there are no other types other than 0.
		0x00, // Interlace: 0 (no).
	];

	var crc = +('0x' + crc32(ihdrContents));

	ihdrCrc = [crc >>> 24 & 255, crc >> 16 & 255, crc >>> 8 & 255, crc & 255]; // IHDR CRC32

	var idat = [
		// IDAT, Image data
		(compressedData.length >>> 24 & 255), (compressedData.length >>> 16 & 255), (compressedData.length >>> 8 & 255), (compressedData.length >>> 0 & 255), // Stream length, UInt32
		0x49, 0x44, 0x41, 0x54 // ASCII: I, D, A, T

		// That's all. We omit the IDAT crc32, and IEND chunk entirely
	];

	var pngLeader = [].concat(pngSignature, ihdrLength, ihdrContents, ihdrCrc, idat);

	var binAsciiString = '';

	var i;
	for (i = 0; i < pngLeader.length; i++) {
		binAsciiString += String.fromCharCode(pngLeader[i]);
	}
	for (i = 0; i < compressedData.length; i++) {
		binAsciiString += String.fromCharCode(compressedData[i]);
	}

	binAsciiString = closeProperly(binAsciiString);

	return binAsciiString;
}


function filterData(data, filterName) {
	// Okay, this is ve-ery simple filtering routine
	// It is applicable only for images 1 px high and bit depth 8

	filterName = (filterName || 'none').toLowerCase();

	var output = [];
	var i;
	var prev;

	switch (filterName) {
		case 'none':
			output.push(0x00); // Filter type
			for (i = 0; i < data.length; i++) {
				output.push(data[i]); // Same as input
			}
			break;
		case 'sub':
			output.push(0x01); // Filter type
			prev = 0x00;
			for (i = 0; i < data.length; i++) {
				output.push((data[i] - prev + 256) & 255); // Delta with previous pixel
				prev = data[i];
			}
			break;
		case 'up':
			output.push(0x02); // Filter type
			for (i = 0; i < data.length; i++) {
				output.push(data[i]); // Same as input, as there are no pixels above
			}
			break;
		case 'average':
			output.push(0x03); // Filter type
			prev = 0x00;
			for (i = 0; i < data.length; i++) {
				output.push((data[i] - (prev >> 1) + 256) & 255); // Delta with average between prev and top pixel. Top is always 0, though.
				prev = data[i];
			}
			break;
		case 'paeth':
			// With all top pixels set to zero, it's effectively a SUB filter
			output.push(0x04); // Filter type
			prev = 0x00;
			for (i = 0; i < data.length; i++) {
				output.push((data[i] - prev + 256) & 255);
				prev = data[i];
			}
			break;
		default:
			throw new Error('unknown filter: ' + filterName);
	}

	return output;
}

function closeProperly (s) {
	var openRe = /(<[\/a-zA-Z][^\s>]*\s*)|(<!--)|(<\?)|(<\[CDATA\[)/g;
	var reWhitespace = /\s+/;
	var tail = '';
	while (true) {
		var match = openRe.exec(s); // Test for any opening constructions
		if (!match) {
			break; // We've finished parsing the string
		}

		if (match[1]) {
			// Okay so we landed here just after the tagname
			// and all the whitespaces after (if any)
			var reAttrName = /\s*(?:(>)|[^\s>]+?(\s*=\s*)?)/g;
			reAttrName.lastIndex = openRe.lastIndex;
			while (true) {
				var matchAttrName = reAttrName.exec(s);
				if (!matchAttrName) {
					// Neither attr name nor closing waka followed
					tail = '>';
					break;
				}
				openRe.lastIndex = reAttrName.lastIndex;

				if (matchAttrName[1]) {
					// Tag is closed
					tail = '';
					break;
				}

				if (matchAttrName[2]) {
					// Attr name found and an equal sign after it
					var reAttrValue = /("|'|`)(?:(?!\1)[^])*(\1)?|[^\s>]*/g;
					reAttrValue.lastIndex = reAttrName.lastIndex;
					var matchAttrValue = reAttrValue.exec(s);
					// Sync back the RE states
					reAttrName.lastIndex = reAttrValue.lastIndex;
					if (matchAttrValue[1] && !matchAttrValue[2]) {
						// Unclosed quote
						tail = matchAttrValue[1] + '>';
						break;
					}
				}
			}
		}

		if (match[2] || match[3] || match[4]) {
			// Unclosed <!--, <? or <![CDATA[
			if (match[2]) {
				tail = '-->';
			} else if (match[3]) {
				tail = '>';
			} else if (match[4]) {
				tail = ']]>';
			}
			// Check if it is closed somewhere
			var index = s.indexOf(tail, openRe.lastIndex);
			if (index !== -1) {
				// It is. Fast-forwarding the main RE to that place
				openRe.lastIndex = index + tail.length;
				tail = '';
			}
		}
	}

	return s + tail;
}