// Fast drop-in for csv-reader 1.0.0: returns exactly csv-reader's answer for every input.
// Strategy: split the text into lines once (native), split clean lines on ',' (native),
// and parse only lines holding a field-start quote with an indexOf-driven field parser.
// Quoted fields may span lines; a lone CR inside quotes counts as a line, as csv-reader does.
const COMMA = 0, BREAK = 1;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const lines = text.split('\n');
  if (lines.length && lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);
  const nLines = lines.length;
  let li = 0;            // current line index
  let extraLines = 0;    // lone CRs inside quoted fields seen so far (each counts as a line)
  let content = '';      // current line content (trailing CRLF \r stripped)
  let lineHasCR = false; // current line content holds a mid-line \r (cached per line)
  let p = 0;             // offset in content
  let recordLine = 1;
  let recordRow = null;
  const effLine = () => li + 1 + extraLines;
  const err = (code) => { errors.push({ code, line: recordLine, row: recordRow }); };

  function loadLine(i) {
    const raw = lines[i];
    // A trailing \r is CRLF only when this line was terminated by '\n' (i.e. not the last
    // line); a \r at the very end of the text is a stray CR, not a line break.
    content = i < nLines - 1 && raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
    lineHasCR = content.indexOf('\r') !== -1;
    p = 0;
  }

  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; return; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Unquoted field from p within content. Returns {value, ended, added}; advances p.
  // lineHasCR is cached per line by loadLine (content only changes through loadLine).
  function readUnquotedLine(value) {
    const crPresent = lineHasCR;
    let v = value, added = 0;
    if (!crPresent) {
      const q = content.indexOf(',', p);
      if (q === -1) {
        if (p < content.length) { v += content.slice(p); added += content.length - p; }
        p = content.length;
        return { value: v, ended: BREAK, added };
      }
      v += content.slice(p, q); added += q - p;
      p = q + 1;
      return { value: v, ended: COMMA, added };
    }
    for (;;) {
      const ci = content.indexOf(',', p);
      const ri = content.indexOf('\r', p);
      if (ri !== -1 && (ci === -1 || ri < ci)) {
        err('stray_cr');
        v += content.slice(p, ri); added += ri - p;
        p = ri + 1;
        continue;
      }
      if (ci === -1) {
        if (p < content.length) { v += content.slice(p); added += content.length - p; }
        p = content.length;
        return { value: v, ended: BREAK, added };
      }
      v += content.slice(p, ci); added += ci - p;
      p = ci + 1;
      return { value: v, ended: COMMA, added };
    }
  }

  // Quoted field at content[p] === '"'. May span lines (advances li/content).
  // Returns {value, ended} with ended COMMA/BREAK, or {unterminated:true, openP}.
  function readQuotedLine() {
    const openLi = li, openP = p, openExtra = extraLines;
    let value = '';
    let cur = content;
    let pos = p + 1;
    const addSeg = (seg) => {
      if (seg.indexOf('\r') !== -1) {
        let c = 0;
        for (let i = seg.indexOf('\r'); i !== -1; i = seg.indexOf('\r', i + 1)) c++;
        extraLines += c;
        seg = seg.replace(/\r\n?/g, '\n');
      }
      value += seg;
    };
    for (;;) {
      // search closing quote in cur from pos, honouring "" doubling
      let closePos = -1;
      const chunks = [];
      let q = pos;
      for (;;) {
        const j = cur.indexOf('"', q);
        if (j === -1) break;
        if (cur.charCodeAt(j + 1) === 34) { chunks.push(cur.slice(q, j + 1)); q = j + 2; continue; }
        chunks.push(cur.slice(q, j)); closePos = j; break;
      }
      if (closePos === -1) {
        // no closing quote on this line: append rest of line + line break, move on
        let seg = chunks.length === 1 ? chunks[0] : chunks.join('');
        if (q < cur.length) seg += cur.slice(q);
        addSeg(seg);
        if (li + 1 >= nLines) {
          // EOF with no close: unterminated (restore state to the opening quote)
          li = openLi; extraLines = openExtra; loadLine(li); p = openP;
          return { unterminated: true, openP };
        }
        value += '\n';
        li++; loadLine(li); cur = content; pos = 0;
        continue;
      }
      // closed on this line
      addSeg(chunks.length === 1 ? chunks[0] : chunks.join(''));
      content = cur; p = closePos + 1;
      if (p >= cur.length) return { value, ended: BREAK };
      const c = cur.charCodeAt(p);
      if (c === 44) { p++; return { value, ended: COMMA }; }
      // anything else: junk up to comma or line end
      const junk = readUnquotedLine(value);
      if (junk.added > 0) err('quote_junk');
      return junk;
    }
  }

  loadLine(0);
  for (;;) {
    // skip empty lines
    while (li < nLines && content === '') { li++; if (li < nLines) loadLine(li); }
    if (li >= nLines) break;
    recordLine = effLine();
    recordRow = header && columns === null ? null : rows.length;

    // Fast line path: no field-start quote and no mid-line \r -> split(',')
    let slow = false;
    let q = content.indexOf('"');
    while (q !== -1) {
      if (q === 0 || content.charCodeAt(q - 1) === 44) { slow = true; break; }
      q = content.indexOf('"', q + 1);
    }
    if (!slow && lineHasCR) slow = true;
    if (!slow) {
      const fields = content.split(',');
      if (fields.length === 1 && fields[0] === '') { li++; if (li < nLines) loadLine(li); continue; }
      finishRecord(fields);
      li++; if (li < nLines) loadLine(li);
      continue;
    }

    // Slow line(s): field-by-field; a quoted field may span lines.
    const fields = [];
    let quoted = false, ended;
    do {
      quoted = content.charCodeAt(p) === 34;
      let f;
      if (quoted) {
        f = readQuotedLine();
        if (f.unterminated) {
          err('unterminated_quote');
          // re-read as unquoted from just after the opening quote, value starts '"'
          p = f.openP + 1;
          f = readUnquotedLine('"');
          quoted = false;
        }
      } else {
        f = readUnquotedLine('');
      }
      fields.push(f.value); ended = f.ended;
      // after a BREAK the record is done; if a quoted field spanned lines, li already advanced
      if (ended === BREAK) {
        li++; if (li < nLines) loadLine(li);
      }
    } while (ended === COMMA);
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
