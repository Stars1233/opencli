/**
 * Aria snapshot formatter: parses Playwright MCP snapshot text into clean format.
 *
 * Multi-pass pipeline:
 * 1. Parse & filter: strip annotations, metadata, noise roles, ads, decorators
 * 2. Deduplicate: generic/text child matching parent label
 * 3. Deduplicate: heading + link with identical labels
 * 4. Deduplicate: nested identical links
 * 5. Prune: empty containers (iterative bottom-up)
 * 6. Collapse: single-child containers
 */

export interface FormatOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
  maxTextLength?: number;
}

const DEFAULT_MAX_TEXT_LENGTH = 200;

// Roles that are pure noise and should always be filtered
const NOISE_ROLES = new Set([
  'none', 'presentation', 'separator', 'paragraph', 'tooltip', 'status',
]);

// Roles whose entire subtree should be removed (footer boilerplate, etc.)
const SUBTREE_NOISE_ROLES = new Set([
  'contentinfo',
]);

// Roles considered interactive (clickable/typeable)
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'combobox', 'tab', 'menuitem', 'option', 'switch',
  'slider', 'spinbutton', 'searchbox',
]);

// Structural landmark roles kept even in interactive mode
const LANDMARK_ROLES = new Set([
  'main', 'navigation', 'banner', 'heading', 'search',
  'region', 'list', 'listitem', 'article', 'complementary',
  'group', 'toolbar', 'tablist',
]);

// Container roles eligible for pruning and collapse
const CONTAINER_ROLES = new Set([
  'list', 'listitem', 'group', 'toolbar', 'tablist',
  'navigation', 'region', 'complementary',
  'search', 'article', 'paragraph', 'figure',
]);

// Decorator / separator text that adds no semantic value
const DECORATOR_TEXT = new Set(['•', '·', '|', '—', '-', '/', '\\']);

// Ad-related URL patterns
const AD_URL_PATTERNS = [
  'googleadservices.com/pagead/',
  'alb.reddit.com/cr?',
  'doubleclick.net/',
  'cm.bilibili.com/cm/api/fees/',
];

// Boilerplate button labels to filter (back-to-top, etc.)
const BOILERPLATE_LABELS = [
  '回到顶部', 'back to top', 'scroll to top', 'go to top',
];

/**
 * Parse role and text from a trimmed snapshot line.
 * Handles quoted labels and trailing text after colon correctly,
 * including lines wrapped in single quotes by Playwright.
 */
function parseLine(trimmed: string): { role: string; text: string; hasText: boolean; trailingText: string } {
  // Unwrap outer single quotes if present (Playwright wraps lines with special chars)
  let line = trimmed;
  if (line.startsWith("'") && line.endsWith("':")) {
    line = line.slice(1, -2) + ':';
  } else if (line.startsWith("'") && line.endsWith("'")) {
    line = line.slice(1, -1);
  }

  // Role is the first word
  const roleMatch = line.match(/^([a-zA-Z]+)\b/);
  const role = roleMatch ? roleMatch[1].toLowerCase() : '';

  // Extract quoted text content (the semantic label)
  const textMatch = line.match(/"([^"]*)"/);
  const text = textMatch ? textMatch[1] : '';

  // For trailing text: strip annotations and quoted strings first, then check after last colon
  // This avoids matching colons inside quoted labels like "Account: user@email.com"
  let stripped = line;
  // Remove all quoted strings
  stripped = stripped.replace(/"[^"]*"/g, '""');
  // Remove all bracket annotations
  stripped = stripped.replace(/\[[^\]]*\]/g, '');

  const colonIdx = stripped.lastIndexOf(':');
  let trailingText = '';
  if (colonIdx !== -1) {
    const afterColon = stripped.slice(colonIdx + 1).trim();
    if (afterColon.length > 0) {
      // Get the actual trailing text from original line at same position
      const origColonIdx = line.lastIndexOf(':');
      if (origColonIdx !== -1) {
        trailingText = line.slice(origColonIdx + 1).trim();
      }
    }
  }

  return { role, text, hasText: text.length > 0 || trailingText.length > 0, trailingText };
}

/**
 * Strip ALL bracket annotations from a content line, preserving quoted strings.
 * Handles both double-quoted and outer single-quoted lines from Playwright.
 */
function stripAnnotations(content: string): string {
  // Unwrap outer single quotes first
  let line = content;
  if (line.startsWith("'") && (line.endsWith("':") || line.endsWith("'"))) {
    if (line.endsWith("':")) {
      line = line.slice(1, -2) + ':';
    } else {
      line = line.slice(1, -1);
    }
  }

  // Split by double quotes to protect quoted content
  const parts = line.split('"');
  for (let i = 0; i < parts.length; i += 2) {
    // Only strip annotations from non-quoted parts (even indices)
    parts[i] = parts[i].replace(/\s*\[[^\]]*\]/g, '');
  }
  let result = parts.join('"').replace(/\s{2,}/g, ' ').trim();

  return result;
}

/**
 * Check if a line is a metadata-only line (like /url: ...).
 */
function isMetadataLine(trimmed: string): boolean {
  return /^\/[a-zA-Z]+:/.test(trimmed);
}

/**
 * Check if text content is purely decorative (separators, dots, etc.)
 */
function isDecoratorText(text: string): boolean {
  return DECORATOR_TEXT.has(text.trim());
}

/**
 * Check if a node is ad-related based on its text content.
 */
function isAdNode(text: string, trailingText: string): boolean {
  const t = (text + ' ' + trailingText).toLowerCase();
  if (t.includes('sponsored') || t.includes('advertisement')) return true;
  if (t.includes('广告')) return true;
  // Check for ad tracking URLs in the label
  for (const pattern of AD_URL_PATTERNS) {
    if (text.includes(pattern) || trailingText.includes(pattern)) return true;
  }
  return false;
}

/**
 * Check if a node is boilerplate UI (back-to-top, etc.)
 */
function isBoilerplateNode(text: string): boolean {
  const t = text.toLowerCase();
  return BOILERPLATE_LABELS.some(label => t.includes(label));
}

/**
 * Check if a role is noise that should be filtered.
 */
function isNoiseNode(role: string, hasText: boolean, text: string, trailingText: string): boolean {
  if (NOISE_ROLES.has(role)) return true;
  // generic without text is a wrapper
  if (role === 'generic' && !hasText) return true;
  // img without alt text is noise
  if (role === 'img' && !hasText) return true;
  // Decorator-only text nodes
  if ((role === 'generic' || role === 'text') && hasText) {
    const content = trailingText || text;
    if (isDecoratorText(content)) return true;
  }
  return false;
}

interface Entry {
  depth: number;
  content: string;
  role: string;
  text: string;
  trailingText: string;
  isInteractive: boolean;
  isLandmark: boolean;
  isSubtreeSkip: boolean; // ad nodes or boilerplate — skip entire subtree
}

export function formatSnapshot(raw: string, opts: FormatOptions = {}): string {
  if (!raw || typeof raw !== 'string') return '';

  const maxTextLen = opts.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const lines = raw.split('\n');

  // === Pass 1: Parse, filter, and collect entries ===
  const entries: Entry[] = [];
  let refCounter = 0;
  let skipUntilDepth = -1; // When >= 0, skip all nodes at depth > this value

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    const depth = Math.floor(indent / 2);

    // If we're in a subtree skip zone, check depth
    if (skipUntilDepth >= 0) {
      if (depth > skipUntilDepth) continue; // still inside subtree
      skipUntilDepth = -1; // exited subtree
    }

    let content = line.trimStart();

    // Strip leading "- "
    if (content.startsWith('- ')) {
      content = content.slice(2);
    }

    // Skip metadata lines
    if (isMetadataLine(content)) continue;

    // Apply maxDepth filter
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) continue;

    const { role, text, hasText, trailingText } = parseLine(content);

    // Skip noise nodes
    if (isNoiseNode(role, hasText, text, trailingText)) continue;

    // Skip subtree noise roles (contentinfo footer, etc.) — skip entire subtree
    if (SUBTREE_NOISE_ROLES.has(role)) {
      skipUntilDepth = depth;
      continue;
    }

    // Strip annotations
    content = stripAnnotations(content);

    // Check if node should trigger subtree skip (ads, boilerplate)
    const isSubtreeSkip = isAdNode(text, trailingText) || isBoilerplateNode(text);

    // Interactive mode filter
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isLandmark = LANDMARK_ROLES.has(role);

    if (opts.interactive && !isInteractive && !isLandmark && !hasText) continue;

    // Compact mode
    if (opts.compact) {
      content = content
        .replace(/\s*\[.*?\]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Text truncation
    if (maxTextLen > 0 && content.length > maxTextLen) {
      content = content.slice(0, maxTextLen) + '…';
    }

    // Assign refs to interactive elements
    if (isInteractive) {
      refCounter++;
      content = `[@${refCounter}] ${content}`;
    }

    entries.push({ depth, content, role, text, trailingText, isInteractive, isLandmark, isSubtreeSkip });
  }

  // === Pass 2: Remove subtree-skip nodes (ads, boilerplate, contentinfo) ===
  let noAds: Entry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isSubtreeSkip) {
      const skipDepth = entry.depth;
      i++;
      while (i < entries.length && entries[i].depth > skipDepth) {
        i++;
      }
      i--;
      continue;
    }
    noAds.push(entry);
  }

  // === Pass 3: Deduplicate child generic/text matching parent label ===
  let deduped: Entry[] = [];
  for (let i = 0; i < noAds.length; i++) {
    const entry = noAds[i];

    if (entry.role === 'generic' || entry.role === 'text') {
      let parent: Entry | undefined;
      for (let j = deduped.length - 1; j >= 0; j--) {
        if (deduped[j].depth < entry.depth) {
          parent = deduped[j];
          break;
        }
        if (deduped[j].depth === entry.depth) break;
      }

      if (parent) {
        const childText = entry.trailingText || entry.text;
        if (childText && parent.text && childText === parent.text) {
          continue;
        }
      }
    }

    deduped.push(entry);
  }

  // === Pass 4: Deduplicate heading + child link with identical label ===
  // Pattern: heading "Title": → link "Title": (same text) → skip the link
  const deduped2: Entry[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const entry = deduped[i];

    if (entry.role === 'heading' && entry.text) {
      const next = deduped[i + 1];
      if (next && next.role === 'link' && next.text === entry.text && next.depth === entry.depth + 1) {
        // Keep the heading, skip the link. But preserve link's children re-parented.
        deduped2.push(entry);
        i++; // skip the link
        continue;
      }
    }

    deduped2.push(entry);
  }

  // === Pass 5: Deduplicate nested identical links ===
  const deduped3: Entry[] = [];
  for (let i = 0; i < deduped2.length; i++) {
    const entry = deduped2[i];

    if (entry.role === 'link' && entry.text) {
      const next = deduped2[i + 1];
      if (next && next.role === 'link' && next.text === entry.text && next.depth === entry.depth + 1) {
        continue; // Skip parent, keep child
      }
    }

    deduped3.push(entry);
  }

  // === Pass 6: Iteratively prune empty containers (bottom-up) ===
  let current = deduped3;
  let changed = true;
  while (changed) {
    changed = false;
    const next: Entry[] = [];
    for (let i = 0; i < current.length; i++) {
      const entry = current[i];
      if (CONTAINER_ROLES.has(entry.role) && !entry.text && !entry.trailingText) {
        let hasChildren = false;
        for (let j = i + 1; j < current.length; j++) {
          if (current[j].depth <= entry.depth) break;
          if (current[j].depth > entry.depth) {
            hasChildren = true;
            break;
          }
        }
        if (!hasChildren) {
          changed = true;
          continue;
        }
      }
      next.push(entry);
    }
    current = next;
  }

  // === Pass 7: Collapse single-child containers ===
  const collapsed: Entry[] = [];
  for (let i = 0; i < current.length; i++) {
    const entry = current[i];

    if (CONTAINER_ROLES.has(entry.role) && !entry.text && !entry.trailingText) {
      let childCount = 0;
      let childIdx = -1;
      for (let j = i + 1; j < current.length; j++) {
        if (current[j].depth <= entry.depth) break;
        if (current[j].depth === entry.depth + 1) {
          childCount++;
          if (childCount === 1) childIdx = j;
        }
      }

      if (childCount === 1 && childIdx !== -1) {
        const child = current[childIdx];
        let hasGrandchildren = false;
        for (let j = childIdx + 1; j < current.length; j++) {
          if (current[j].depth <= child.depth) break;
          if (current[j].depth > child.depth) {
            hasGrandchildren = true;
            break;
          }
        }

        if (!hasGrandchildren) {
          const mergedContent = entry.content.replace(/:$/, '') + ' > ' + child.content;
          collapsed.push({
            ...entry,
            content: mergedContent,
            role: child.role,
            text: child.text,
            trailingText: child.trailingText,
            isInteractive: child.isInteractive,
          });
          i++;
          continue;
        }
      }
    }

    collapsed.push(entry);
  }

  return collapsed.map(e => '  '.repeat(e.depth) + e.content).join('\n');
}
