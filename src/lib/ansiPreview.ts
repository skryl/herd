export interface AnsiPreviewSegment {
  text: string;
  foreground: string | null;
  background: string | null;
}

export type AnsiPreviewLine = AnsiPreviewSegment[];

function rgbString(red: number, green: number, blue: number) {
  return `rgb(${red}, ${green}, ${blue})`;
}

function clampByte(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
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
    index += 1;
  }

  return { foreground, background };
}

export function parseAnsiPreview(text: string): AnsiPreviewLine[] {
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

  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === '\u001b' && text[index + 1] === '[') {
      const end = text.indexOf('m', index + 2);
      if (end === -1) {
        index += 1;
        continue;
      }
      ({ foreground: currentForeground, background: currentBackground } = parseSgrSequence(
        text.slice(index + 2, end),
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
