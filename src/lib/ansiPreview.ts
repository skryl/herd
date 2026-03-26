export interface AnsiPreviewSegment {
  text: string;
  foreground: string | null;
  background: string | null;
}

export type AnsiPreviewLine = AnsiPreviewSegment[];

function rgbString(red: number, green: number, blue: number) {
  return `rgb(${red}, ${green}, ${blue})`;
}

const ANSI_BASE_PALETTE = [
  rgbString(10, 14, 8),
  rgbString(255, 51, 51),
  rgbString(51, 255, 51),
  rgbString(255, 170, 0),
  rgbString(51, 136, 255),
  rgbString(204, 51, 255),
  rgbString(51, 204, 204),
  rgbString(192, 200, 184),
] as const;

const ANSI_BRIGHT_PALETTE = [
  rgbString(42, 58, 32),
  rgbString(255, 85, 85),
  rgbString(85, 255, 85),
  rgbString(255, 204, 51),
  rgbString(85, 153, 255),
  rgbString(221, 85, 255),
  rgbString(85, 221, 221),
  rgbString(224, 232, 216),
] as const;

function clampByte(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function normalizeAnsiEscapes(text: string) {
  return text
    .replace(/&#(?:x0*1b|0*27);/gi, '\u001b')
    .replace(/\\u001b/gi, '\u001b')
    .replace(/\\x1b/gi, '\u001b');
}

function paletteColor(code: number) {
  if (code >= 30 && code <= 37) {
    return ANSI_BASE_PALETTE[code - 30];
  }
  if (code >= 40 && code <= 47) {
    return ANSI_BASE_PALETTE[code - 40];
  }
  if (code >= 90 && code <= 97) {
    return ANSI_BRIGHT_PALETTE[code - 90];
  }
  if (code >= 100 && code <= 107) {
    return ANSI_BRIGHT_PALETTE[code - 100];
  }
  return null;
}

function ansi256Color(index: number) {
  const normalized = clampByte(index);
  if (normalized < 8) {
    return ANSI_BASE_PALETTE[normalized];
  }
  if (normalized < 16) {
    return ANSI_BRIGHT_PALETTE[normalized - 8];
  }
  if (normalized < 232) {
    const cubeIndex = normalized - 16;
    const red = Math.floor(cubeIndex / 36);
    const green = Math.floor((cubeIndex % 36) / 6);
    const blue = cubeIndex % 6;
    const channelValues = [0, 95, 135, 175, 215, 255] as const;
    return rgbString(channelValues[red], channelValues[green], channelValues[blue]);
  }
  const grayscale = 8 + (normalized - 232) * 10;
  return rgbString(grayscale, grayscale, grayscale);
}

function parseSgrSequence(
  sequence: string,
  currentForeground: string | null,
  currentBackground: string | null,
) {
  const numericCodes = sequence
    .split(';')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
  let foreground = currentForeground;
  let background = currentBackground;

  for (let index = 0; index < numericCodes.length;) {
    const code = numericCodes[index];
    if (code === 0) {
      foreground = null;
      background = null;
      index += 1;
      continue;
    }
    if (code === 39) {
      foreground = null;
      index += 1;
      continue;
    }
    if (code === 49) {
      background = null;
      index += 1;
      continue;
    }
    if ((code === 38 || code === 48) && numericCodes[index + 1] === 2 && index + 4 < numericCodes.length) {
      const color = rgbString(
        clampByte(numericCodes[index + 2]),
        clampByte(numericCodes[index + 3]),
        clampByte(numericCodes[index + 4]),
      );
      if (code === 38) {
        foreground = color;
      } else {
        background = color;
      }
      index += 5;
      continue;
    }
    if ((code === 38 || code === 48) && numericCodes[index + 1] === 5 && index + 2 < numericCodes.length) {
      const color = ansi256Color(numericCodes[index + 2]);
      if (code === 38) {
        foreground = color;
      } else {
        background = color;
      }
      index += 3;
      continue;
    }
    const directColor = paletteColor(code);
    if (directColor) {
      if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        foreground = directColor;
      } else {
        background = directColor;
      }
      index += 1;
      continue;
    }
    index += 1;
  }

  return { foreground, background };
}

export function parseAnsiPreview(text: string): AnsiPreviewLine[] {
  const normalizedText = normalizeAnsiEscapes(text);
  const lines: AnsiPreviewLine[] = [[]];
  let currentForeground: string | null = null;
  let currentBackground: string | null = null;
  let lineIndex = 0;

  function currentLine() {
    return lines[lineIndex];
  }

  function appendText(characters: string) {
    if (!characters) return;
    const line = currentLine();
    const previousSegment = line[line.length - 1];
    if (
      previousSegment
      && previousSegment.foreground === currentForeground
      && previousSegment.background === currentBackground
    ) {
      previousSegment.text += characters;
      return;
    }
    line.push({
      text: characters,
      foreground: currentForeground,
      background: currentBackground,
    });
  }

  for (let index = 0; index < normalizedText.length;) {
    const char = normalizedText[index];
    if (char === '\u001b' && normalizedText[index + 1] === '[') {
      const end = normalizedText.indexOf('m', index + 2);
      if (end === -1) {
        index += 1;
        continue;
      }
      ({ foreground: currentForeground, background: currentBackground } = parseSgrSequence(
        normalizedText.slice(index + 2, end),
        currentForeground,
        currentBackground,
      ));
      index = end + 1;
      continue;
    }
    if (char === '\n') {
      lines.push([]);
      lineIndex += 1;
      index += 1;
      continue;
    }
    if (char === '\r') {
      index += 1;
      continue;
    }
    appendText(char);
    index += 1;
  }

  return lines;
}
