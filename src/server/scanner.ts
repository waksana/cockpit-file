export interface MarkdownReference {
  /** Markdown escapes/entities removed; URL and local-path policy belongs to the caller. */
  target: string;
  label?: string;
  image: boolean;
}
export interface ScannerDiagnostic {
  code: 'candidate-limit' | 'reference-limit';
  offset: number;
  message: string;
}
export interface ScannerStats {
  scannedChars: number;
  transitions: number;
  maxBufferedChars: number;
  normalizations: number;
  emittedReferences: number;
  droppedCandidates: number;
}
export interface MarkdownScannerOptions {
  maxCandidateChars?: number;
  maxReferences?: number;
}
export interface MarkdownScanner {
  feed(delta: string): MarkdownReference[];
  finish(): MarkdownReference[];
  readonly stats: Readonly<ScannerStats>;
  readonly diagnostics: readonly ScannerDiagnostic[];
}

type Phase = 'label' | 'open' | 'leading' | 'bare' | 'angle' | 'after' | 'title' | 'trailing';
interface Candidate {
  phase: Phase;
  label: string[];
  target: string[];
  image: boolean;
  chars: number;
  depth: number;
  escaped: boolean;
  titleDelimiter: string;
  separated: boolean;
}
interface Run { char: string; count: number; fenceEligible: boolean }
interface HtmlCode {
  tag: string;
  opening: boolean;
  quote: string;
  matched: number;
}
const HTML_OPENERS = ['<!--', '<pre', '<script', '<style', '<textarea', '<code'];
const PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

function normalize(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-fA-F]{1,6});/g, entity => {
      const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (named[entity]) return named[entity];
      const hex = entity.startsWith('&#x');
      const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : '\ufffd';
    });
}

/**
 * Single-pass best-effort inline Markdown scanner, not a complete CommonMark parser.
 * Naked prose paths and reference definitions are not recognized as links.
 * Indented lines, HTML comments and raw code-like HTML elements are conservatively
 * suppressed. Other HTML/CommonMark context is not modeled. Limits bound candidates,
 * deduplication and diagnostics.
 */
export function createMarkdownScanner(options: MarkdownScannerOptions = {}): MarkdownScanner {
  const maxCandidateChars = options.maxCandidateChars ?? 8192;
  const maxReferences = options.maxReferences ?? 1024;
  if (!Number.isSafeInteger(maxCandidateChars) || maxCandidateChars < 16 || maxCandidateChars > 1024 * 1024 ||
      !Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > 65536) {
    throw new RangeError('Invalid Markdown scanner limits');
  }
  const stats: ScannerStats = {
    scannedChars: 0, transitions: 0, maxBufferedChars: 0,
    normalizations: 0, emittedReferences: 0, droppedCandidates: 0,
  };
  const diagnostics: ScannerDiagnostic[] = [];
  const diagnosticCodes = new Set<ScannerDiagnostic['code']>();
  const rawTargets = new Set<string>();
  const targets = new Set<string>();
  let candidate: Candidate | undefined;
  let run: Run | undefined;
  let fence: { char: string; count: number } | undefined;
  let fenceClosing = false;
  let inlineTicks = 0;
  let linePrefix = true;
  let indent = 0;
  let textEscaped = false;
  let bang = false;
  let discarding = false;
  let indentedLine = false;
  let htmlProbe = '';
  let htmlCode: HtmlCode | undefined;
  let finished = false;

  function diagnostic(code: ScannerDiagnostic['code'], message: string) {
    if (!diagnosticCodes.has(code)) {
      diagnosticCodes.add(code);
      diagnostics.push({ code, message, offset: stats.scannedChars });
    }
  }
  function emit(link: Candidate, output: MarkdownReference[]) {
    const raw = link.target.join('');
    if (!raw || rawTargets.has(raw)) return;
    if (targets.size >= maxReferences || rawTargets.size >= maxReferences * 4) {
      diagnostic('reference-limit', 'Reference deduplication limit reached; further new targets are ignored');
      return;
    }
    rawTargets.add(raw);
    stats.normalizations++;
    const target = normalize(raw);
    if (!target || /[\u0000-\u001f\u007f]/.test(target) || targets.has(target)) return;
    targets.add(target);
    stats.emittedReferences++;
    const label = normalize(link.label.join(''));
    output.push({ target, ...(label ? { label } : {}), image: link.image });
  }
  function candidateChar(char: string, output: MarkdownReference[]): boolean {
    const link = candidate!;
    link.chars++;
    stats.maxBufferedChars = Math.max(stats.maxBufferedChars, Math.min(link.chars, maxCandidateChars));
    if (link.chars > maxCandidateChars) {
      stats.droppedCandidates++;
      diagnostic('candidate-limit', 'Unfinished Markdown candidate exceeded the character limit; skipping to the next line');
      candidate = undefined;
      discarding = char !== '\n';
      return true;
    }
    if (link.phase === 'open') {
      if (char === '(') { link.phase = 'leading'; return true; }
      candidate = undefined;
      return false;
    }
    if (link.phase === 'label') {
      if (link.escaped) { link.label.push('\\', char); link.escaped = false; return true; }
      if (char === '\\') { link.escaped = true; return true; }
      if (char === '[') link.depth++;
      if (char === ']') {
        if (link.depth === 0) { link.phase = 'open'; return true; }
        link.depth--;
      }
      link.label.push(char);
      return true;
    }
    if (link.phase === 'leading') {
      if (/\s/.test(char)) return true;
      if (char === '<') { link.phase = 'angle'; return true; }
      link.phase = 'bare';
    }
    if (link.phase === 'bare' || link.phase === 'angle') {
      if (link.escaped) {
        link.escaped = false;
        if (PUNCTUATION.test(char)) { link.target.push('\\', char); return true; }
        link.target.push('\\');
      } else if (char === '\\') { link.escaped = true; return true; }
      if (link.phase === 'angle') {
        if (char === '>') { link.phase = 'after'; link.separated = false; return true; }
        if (char === '\n' || char === '\r' || char === '<') { candidate = undefined; return true; }
        link.target.push(char);
        return true;
      }
      if (/\s/.test(char)) {
        if (link.depth !== 0) candidate = undefined;
        else { link.phase = 'after'; link.separated = true; }
        return true;
      }
      if (char === '(') link.depth++;
      if (char === ')') {
        if (link.depth === 0) { emit(link, output); candidate = undefined; return true; }
        link.depth--;
      }
      if (char === '<') { candidate = undefined; return true; }
      link.target.push(char);
      return true;
    }
    if (link.phase === 'after' || link.phase === 'trailing') {
      if (/\s/.test(char)) { link.separated = true; return true; }
      if (char === ')') { emit(link, output); candidate = undefined; return true; }
      if (link.phase === 'after' && link.separated && (char === '"' || char === "'" || char === '(')) {
        link.phase = 'title';
        link.titleDelimiter = char === '(' ? ')' : char;
        return true;
      }
      candidate = undefined;
      return false;
    }
    if (link.phase === 'title') {
      if (link.escaped) { link.escaped = false; return true; }
      if (char === '\\') { link.escaped = true; return true; }
      if (char === link.titleDelimiter) link.phase = 'trailing';
      return true;
    }
    return true;
  }
  function flushRun() {
    const previous = run!;
    run = undefined;
    if (fence) {
      if (previous.char === fence.char && previous.count >= fence.count && previous.fenceEligible) fenceClosing = true;
    } else if (inlineTicks) {
      if (previous.char === '`' && previous.count === inlineTicks) inlineTicks = 0;
    } else if (previous.fenceEligible && previous.count >= 3) {
      fence = { char: previous.char, count: previous.count };
      candidate = undefined;
      bang = false;
    } else if (previous.char === '`') {
      inlineTicks = previous.count;
      bang = false;
    }
  }
  function htmlCharacter(char: string) {
    const html = htmlCode!;
    if (html.tag === '!--') {
      if (char === '-' && html.matched < 2) html.matched++;
      else if (char === '>' && html.matched === 2) htmlCode = undefined;
      else if (char !== '-') html.matched = 0;
      return;
    }
    if (html.opening) {
      if (html.quote) { if (char === html.quote) html.quote = ''; }
      else if (char === '"' || char === "'") html.quote = char;
      else if (char === '>') html.opening = false;
      return;
    }
    const closing = `</${html.tag}`;
    if (html.matched === closing.length) {
      if (char === '>') {
        htmlCode = undefined;
        discarding = html.tag !== 'code';
        return;
      }
      if (/\s/.test(char)) return;
    } else if (char.toLowerCase() === closing[html.matched]) {
      html.matched++;
      return;
    }
    html.matched = char === '<' ? 1 : 0;
  }
  function probeHtml(char: string): boolean {
    const previous = htmlProbe;
    const next = previous + char.toLowerCase();
    if (next === '<!--') {
      htmlCode = { tag: '!--', opening: false, quote: '', matched: 0 };
      htmlProbe = '';
      return true;
    }
    if (HTML_OPENERS.includes(previous) && /[\s/>]/.test(char)) {
      htmlCode = { tag: previous.slice(1), opening: true, quote: '', matched: 0 };
      htmlProbe = '';
      htmlCharacter(char);
      return true;
    }
    if (HTML_OPENERS.some(opener => opener.startsWith(next))) {
      htmlProbe = next;
      stats.maxBufferedChars = Math.max(stats.maxBufferedChars, next.length);
      return true;
    }
    htmlProbe = '';
    return false;
  }
  function character(char: string, fenceEligible: boolean, output: MarkdownReference[]) {
    stats.transitions++;
    if (run) {
      if (char === run.char) { run.count++; return; }
      flushRun();
    }
    if (fence) {
      if (char === '\n') { if (fenceClosing) fence = undefined; fenceClosing = false; }
      else if (fenceClosing && char !== ' ' && char !== '\t' && char !== '\r') fenceClosing = false;
      if (fence && fenceEligible && char === fence.char) run = { char, count: 1, fenceEligible };
      return;
    }
    if (htmlCode) { htmlCharacter(char); return; }
    if (indentedLine || (linePrefix && (indent >= 4 || char === '\t'))) {
      indentedLine = char !== '\n';
      candidate = undefined;
      htmlProbe = '';
      textEscaped = false;
      bang = false;
      return;
    }
    if (inlineTicks) {
      if (char === '`') run = { char, count: 1, fenceEligible: false };
      return;
    }
    if (htmlProbe && probeHtml(char)) return;
    if (char === '<' && !textEscaped && !candidate?.escaped &&
        candidate?.phase !== 'leading' && candidate?.phase !== 'title') {
      candidate = undefined;
      htmlProbe = '<';
      bang = false;
      return;
    }
    if (discarding) { if (char === '\n') discarding = false; return; }
    if (candidate) {
      if (candidateChar(char, output)) return;
      stats.transitions++;
    }
    if (textEscaped) { textEscaped = false; bang = false; return; }
    if (char === '\\') { textEscaped = true; bang = false; return; }
    if (char === '`' || (char === '~' && fenceEligible)) {
      run = { char, count: 1, fenceEligible };
      return;
    }
    if (char === '[') {
      candidate = {
        phase: 'label', label: [], target: [], image: bang, chars: 1, depth: 0,
        escaped: false, titleDelimiter: '', separated: false,
      };
    }
    bang = char === '!';
  }
  return {
    feed(delta) {
      if (finished) throw new Error('Markdown scanner already finished');
      if (typeof delta !== 'string') throw new TypeError('Markdown delta must be a string');
      const output: MarkdownReference[] = [];
      for (let index = 0; index < delta.length; index++) {
        const char = delta[index]!;
        stats.scannedChars++;
        character(char, linePrefix && indent <= 3, output);
        if (char === '\n') { linePrefix = true; indent = 0; }
        else if (linePrefix && char === ' ') indent++;
        else if (linePrefix && char === '\t') indent += 4 - indent % 4;
        else linePrefix = false;
      }
      return output;
    },
    finish() {
      if (!finished) {
        finished = true;
        if (run) flushRun();
        candidate = undefined;
        run = undefined;
        fence = undefined;
        htmlCode = undefined;
        htmlProbe = '';
        rawTargets.clear();
        targets.clear();
      }
      return [];
    },
    get stats() { return { ...stats }; },
    get diagnostics() { return diagnostics.slice(); },
  };
}
