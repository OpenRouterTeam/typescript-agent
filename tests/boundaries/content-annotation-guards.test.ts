import { describe, expect, it } from 'vitest';

import {
  hasTypeProperty,
  isFileCitationAnnotation,
  isFilePathAnnotation,
  isOutputTextPart,
  isRefusalPart,
  isURLCitationAnnotation,
} from '../../src/lib/stream-type-guards.js';

describe('Content part and annotation guards - boundary between similar types', () => {
  it('isOutputTextPart: true for output_text, false for refusal', () => {
    expect(
      isOutputTextPart({
        type: 'output_text',
      }),
    ).toBe(true);
    expect(
      isOutputTextPart({
        type: 'refusal',
      }),
    ).toBe(false);
  });

  it('isRefusalPart: true for refusal, false for output_text', () => {
    expect(
      isRefusalPart({
        type: 'refusal',
      }),
    ).toBe(true);
    expect(
      isRefusalPart({
        type: 'output_text',
      }),
    ).toBe(false);
  });

  it('isFileCitationAnnotation: true for file_citation, false for url_citation', () => {
    expect(
      isFileCitationAnnotation({
        type: 'file_citation',
      }),
    ).toBe(true);
    expect(
      isFileCitationAnnotation({
        type: 'url_citation',
      }),
    ).toBe(false);
  });

  it('isURLCitationAnnotation: true for url_citation, false for file_citation', () => {
    expect(
      isURLCitationAnnotation({
        type: 'url_citation',
      }),
    ).toBe(true);
    expect(
      isURLCitationAnnotation({
        type: 'file_citation',
      }),
    ).toBe(false);
  });

  it('isFilePathAnnotation: true for file_path, false for file_citation', () => {
    expect(
      isFilePathAnnotation({
        type: 'file_path',
      }),
    ).toBe(true);
    expect(
      isFilePathAnnotation({
        type: 'file_citation',
      }),
    ).toBe(false);
  });

  it('hasTypeProperty: { type: "x" } -> true; { type: 123 } -> false; null -> false', () => {
    expect(
      hasTypeProperty({
        type: 'x',
      }),
    ).toBe(true);
    expect(
      hasTypeProperty({
        type: 123,
      }),
    ).toBe(false);
    expect(hasTypeProperty(null)).toBe(false);
  });
});
