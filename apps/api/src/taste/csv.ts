/**
 * Minimal RFC 4180 CSV parser: quoted fields may contain commas, quotes ("")
 * and line breaks; CRLF and LF both end a record. Enough for Goodreads and
 * StoryGraph exports, which put free text (reviews) in quoted fields.
 * Stops after `maxRecords` records so a huge file cannot exhaust memory.
 */
export function parseCsv(text: string, maxRecords = Number.POSITIVE_INFINITY): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // Byte-order mark.

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    // Skip blank lines.
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };

  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      if (records.length >= maxRecords) return records;
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length > 0) endRecord();
  return records;
}
