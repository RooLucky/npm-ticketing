import { CliError } from "./errors.js";

/**
 * Parse the JSON-with-comments format commonly used by tsconfig.json. This is
 * intentionally small, but unlike a regular expression it does not damage
 * comment-like text inside quoted strings.
 */
export function parseJsonc<T>(source: string, description: string): T {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
      continue;
    }

    if (character === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
      continue;
    }

    output += character;
  }

  // JSONC permits trailing commas. At this point comments and strings have
  // already been handled, so a conservative comma cleanup is safe.
  output = output.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new CliError(`Could not parse ${description}.`, 1, {
      cause: error,
    });
  }
}
