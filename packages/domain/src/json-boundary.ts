const JSON_MAX_NESTING_DEPTH = 64;

export const hasUnambiguousJsonStructure = (text: string): boolean => {
  const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const skipWhitespace = (start: number): number => {
    let cursor = start;
    while (
      text[cursor] === " " ||
      text[cursor] === "\t" ||
      text[cursor] === "\n" ||
      text[cursor] === "\r"
    ) {
      cursor += 1;
    }
    return cursor;
  };
  const scanString = (
    start: number,
  ): { readonly end: number; readonly value: string } | null => {
    if (text[start] !== '"') {
      return null;
    }
    let cursor = start + 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '"') {
        const end = cursor + 1;
        try {
          const value: unknown = JSON.parse(text.slice(start, end));
          return typeof value === "string" ? { end, value } : null;
        } catch {
          return null;
        }
      }
      cursor += 1;
    }
    return null;
  };
  const scanValue = (start: number, depth: number): number => {
    if (depth > JSON_MAX_NESTING_DEPTH) {
      return -1;
    }
    let cursor = skipWhitespace(start);
    if (text[cursor] === '"') {
      return scanString(cursor)?.end ?? -1;
    }
    if (text[cursor] === "{") {
      cursor = skipWhitespace(cursor + 1);
      const keys = new Set<string>();
      if (text[cursor] === "}") {
        return cursor + 1;
      }
      while (cursor < text.length) {
        const key = scanString(cursor);
        if (key === null || keys.has(key.value)) {
          return -1;
        }
        keys.add(key.value);
        cursor = skipWhitespace(key.end);
        if (text[cursor] !== ":") {
          return -1;
        }
        cursor = scanValue(cursor + 1, depth + 1);
        if (cursor < 0) {
          return -1;
        }
        cursor = skipWhitespace(cursor);
        if (text[cursor] === "}") {
          return cursor + 1;
        }
        if (text[cursor] !== ",") {
          return -1;
        }
        cursor = skipWhitespace(cursor + 1);
      }
      return -1;
    }
    if (text[cursor] === "[") {
      cursor = skipWhitespace(cursor + 1);
      if (text[cursor] === "]") {
        return cursor + 1;
      }
      while (cursor < text.length) {
        cursor = scanValue(cursor, depth + 1);
        if (cursor < 0) {
          return -1;
        }
        cursor = skipWhitespace(cursor);
        if (text[cursor] === "]") {
          return cursor + 1;
        }
        if (text[cursor] !== ",") {
          return -1;
        }
        cursor = skipWhitespace(cursor + 1);
      }
      return -1;
    }
    for (const literal of ["true", "false", "null"] as const) {
      if (text.startsWith(literal, cursor)) {
        return cursor + literal.length;
      }
    }
    numberPattern.lastIndex = cursor;
    const number = numberPattern.exec(text);
    return number?.index === cursor ? numberPattern.lastIndex : -1;
  };

  const start = skipWhitespace(0);
  const end = scanValue(start, 0);
  return end >= 0 && skipWhitespace(end) === text.length;
};
