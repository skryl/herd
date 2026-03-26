import { describe, expect, it } from 'vitest';

import { parseAnsiPreview } from './ansiPreview';

describe('parseAnsiPreview', () => {
  it('groups text by matching foreground and background colors', () => {
    const lines = parseAnsiPreview('\u001b[38;2;255;0;0m\u001b[48;2;0;0;0m▀▀\u001b[0m');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([
      {
        text: '▀▀',
        foreground: 'rgb(255, 0, 0)',
        background: 'rgb(0, 0, 0)',
      },
    ]);
  });

  it('splits lines and resets colors on 0m', () => {
    const lines = parseAnsiPreview('A\u001b[38;2;0;255;0mB\u001b[0mC\nD');

    expect(lines).toEqual([
      [
        { text: 'A', foreground: null, background: null },
        { text: 'B', foreground: 'rgb(0, 255, 0)', background: null },
        { text: 'C', foreground: null, background: null },
      ],
      [
        { text: 'D', foreground: null, background: null },
      ],
    ]);
  });

  it('ignores unsupported sgr codes while preserving supported colors', () => {
    const lines = parseAnsiPreview('\u001b[1;38;2;12;34;56mX');

    expect(lines[0]).toEqual([
      {
        text: 'X',
        foreground: 'rgb(12, 34, 56)',
        background: null,
      },
    ]);
  });

  it('renders standard ansi palette colors from html-escaped escape sequences', () => {
    const lines = parseAnsiPreview('&#x1b;[31m█&#x1b;[0m');

    expect(lines[0]).toEqual([
      {
        text: '█',
        foreground: 'rgb(255, 51, 51)',
        background: null,
      },
    ]);
  });

  it('renders 256-color ansi sequences from literal backslash escapes', () => {
    const lines = parseAnsiPreview('\\u001b[38;5;214mX\\u001b[48;5;17mY\\u001b[0m');

    expect(lines[0]).toEqual([
      {
        text: 'X',
        foreground: 'rgb(255, 175, 0)',
        background: null,
      },
      {
        text: 'Y',
        foreground: 'rgb(255, 175, 0)',
        background: 'rgb(0, 0, 95)',
      },
    ]);
  });
});
