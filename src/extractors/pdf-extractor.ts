/**
 * PDF Content Extractor
 *
 * Extracts text content from PDF files using pdf.js.
 * Does NOT perform OCR - only extracts embedded text.
 */

import type { ExtractedContent } from '../types.js';
import { getConfig } from '../config.js';

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modDate?: Date;
  pageCount: number;
}

export interface PdfExtractionResult {
  success: boolean;
  content?: ExtractedContent;
  markdown?: string;
  metadata?: PdfMetadata;
  error?: string;
  warnings: string[];
  lowConfidence: boolean;
}

/**
 * Extract text from PDF buffer
 */
export async function extractPdf(
  buffer: Buffer,
  sourceUrl?: string
): Promise<PdfExtractionResult> {
  const config = getConfig();
  const warnings: string[] = [];

  if (!config.pdfEnabled) {
    return {
      success: false,
      error: 'PDF extraction is disabled',
      warnings: [],
      lowConfidence: false,
    };
  }

  try {
    // Dynamic import to avoid loading if not needed
    const pdfjsLib = await import('pdfjs-dist');

    // Create document
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      disableFontFace: true,
    });

    const pdfDoc = await loadingTask.promise;

    // Get metadata
    const metadataObj = await pdfDoc.getMetadata();
    const info = metadataObj.info as Record<string, unknown>;

    const metadata: PdfMetadata = {
      title: info['Title'] as string | undefined,
      author: info['Author'] as string | undefined,
      subject: info['Subject'] as string | undefined,
      creator: info['Creator'] as string | undefined,
      producer: info['Producer'] as string | undefined,
      pageCount: pdfDoc.numPages,
    };

    // Parse dates if present
    if (info['CreationDate']) {
      const dateStr = String(info['CreationDate']);
      metadata.creationDate = parsePdfDate(dateStr);
    }
    if (info['ModDate']) {
      const dateStr = String(info['ModDate']);
      metadata.modDate = parsePdfDate(dateStr);
    }

    // Extract text from each page
    const pageTexts: string[] = [];
    let totalChars = 0;
    let emptyPages = 0;

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Combine text items
      const pageText = textContent.items
        .flatMap(item => ('str' in item ? [item.str] : []))
        .join(' ');

      const cleanedText = pageText.trim();

      if (cleanedText.length === 0) {
        emptyPages++;
      } else {
        totalChars += cleanedText.length;
      }

      pageTexts.push(cleanedText);
    }

    // Determine confidence level
    const avgCharsPerPage = totalChars / pdfDoc.numPages;
    const emptyPageRatio = emptyPages / pdfDoc.numPages;

    // Low confidence if:
    // - Very few characters per page (likely scanned)
    // - High ratio of empty pages
    const lowConfidence = avgCharsPerPage < 100 || emptyPageRatio > 0.5;

    if (lowConfidence) {
      warnings.push(
        'Low text extraction confidence - PDF may be scanned images. ' +
        `Average ${Math.round(avgCharsPerPage)} chars/page, ${emptyPages}/${pdfDoc.numPages} empty pages.`
      );
    }

    // Build markdown output
    const markdownParts: string[] = [];

    if (metadata.title) {
      markdownParts.push(`# ${metadata.title}\n`);
    }

    // Add metadata block
    const metaLines: string[] = [];
    if (metadata.author) metaLines.push(`- **Author:** ${metadata.author}`);
    if (metadata.creationDate) metaLines.push(`- **Created:** ${metadata.creationDate.toISOString().split('T')[0]}`);
    metaLines.push(`- **Pages:** ${metadata.pageCount}`);

    if (metaLines.length > 0) {
      markdownParts.push(metaLines.join('\n') + '\n');
    }

    // Add page content
    pageTexts.forEach((text, idx) => {
      if (text) {
        markdownParts.push(`## Page ${idx + 1}\n\n${text}\n`);
      }
    });

    const markdown = markdownParts.join('\n').trim();
    const textContent = pageTexts.join('\n\n').trim();

    const content: ExtractedContent = {
      title: metadata.title || `PDF Document (${metadata.pageCount} pages)`,
      content: markdown,
      textContent,
      excerpt: textContent.substring(0, 300),
      byline: metadata.author,
      publishedTime: metadata.creationDate?.toISOString(),
    };

    return {
      success: true,
      content,
      markdown,
      metadata,
      warnings,
      lowConfidence,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';

    // Check for common PDF errors
    if (message.includes('Invalid PDF')) {
      return {
        success: false,
        error: 'Invalid or corrupted PDF file',
        warnings,
        lowConfidence: false,
      };
    }

    if (message.includes('password')) {
      return {
        success: false,
        error: 'PDF is password protected',
        warnings,
        lowConfidence: false,
      };
    }

    return {
      success: false,
      error: `PDF extraction failed: ${message}`,
      warnings,
      lowConfidence: false,
    };
  }
}

/**
 * Parse PDF date string (format: D:YYYYMMDDHHmmss+HH'mm')
 */
function parsePdfDate(dateStr: string): Date | undefined {
  try {
    // Remove D: prefix
    let str = dateStr.replace(/^D:/, '');

    // Parse components
    const year = parseInt(str.substring(0, 4), 10);
    const month = parseInt(str.substring(4, 6) || '01', 10) - 1;
    const day = parseInt(str.substring(6, 8) || '01', 10);
    const hour = parseInt(str.substring(8, 10) || '00', 10);
    const minute = parseInt(str.substring(10, 12) || '00', 10);
    const second = parseInt(str.substring(12, 14) || '00', 10);

    const date = new Date(Date.UTC(year, month, day, hour, minute, second));

    if (isNaN(date.getTime())) {
      return undefined;
    }

    return date;
  } catch {
    return undefined;
  }
}

/**
 * Quick check if buffer looks like a PDF
 */
export function isPdfBuffer(buffer: Buffer): boolean {
  // PDF files start with %PDF-
  return buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-';
}
