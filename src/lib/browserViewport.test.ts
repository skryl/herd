import { describe, expect, it } from 'vitest';

import {
  browserWebviewPageZoom,
  clampBrowserPageZoom,
  formatBrowserPageZoom,
  stepBrowserPageZoom,
} from './browserViewport';

describe('clampBrowserPageZoom', () => {
  it('falls back safely for invalid inputs', () => {
    expect(clampBrowserPageZoom(0)).toBe(1);
    expect(clampBrowserPageZoom(Number.NaN)).toBe(1);
    expect(clampBrowserPageZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('clamps to the supported browser page-zoom range', () => {
    expect(clampBrowserPageZoom(0.1)).toBe(0.25);
    expect(clampBrowserPageZoom(40)).toBe(20);
    expect(clampBrowserPageZoom(1.13)).toBe(1.13);
  });
});

describe('stepBrowserPageZoom', () => {
  it('steps browser page zoom up and down in fixed increments', () => {
    expect(stepBrowserPageZoom(1, 'in')).toBe(1.1);
    expect(stepBrowserPageZoom(1.1, 'out')).toBe(1);
  });

  it('respects the supported min and max while stepping', () => {
    expect(stepBrowserPageZoom(0.25, 'out')).toBe(0.25);
    expect(stepBrowserPageZoom(20, 'in')).toBe(20);
  });
});

describe('formatBrowserPageZoom', () => {
  it('formats the current zoom as a percentage label', () => {
    expect(formatBrowserPageZoom(1)).toBe('100%');
    expect(formatBrowserPageZoom(1.1)).toBe('110%');
    expect(formatBrowserPageZoom(0.25)).toBe('25%');
  });
});

describe('browserWebviewPageZoom', () => {
  it('applies canvas zoom in the same direction on top of explicit browser zoom', () => {
    expect(browserWebviewPageZoom(1, 2)).toBe(2);
    expect(browserWebviewPageZoom(1.1, 2)).toBe(2.2);
    expect(browserWebviewPageZoom(1, 0.5)).toBe(0.5);
  });

  it('falls back to the explicit browser zoom for invalid canvas zoom', () => {
    expect(browserWebviewPageZoom(1.1, 0)).toBe(1.1);
    expect(browserWebviewPageZoom(1.1, Number.NaN)).toBe(1.1);
  });

  it('clamps coupled zoom to the supported webview range', () => {
    expect(browserWebviewPageZoom(20, 2)).toBe(20);
    expect(browserWebviewPageZoom(0.25, 0.25)).toBe(0.25);
  });
});
