export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith("/")) {
    return null;
  }

  const firstSpace = text.indexOf(" ");
  const head = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const rawArgs = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
  const name = head.slice(1).split("@")[0]?.toLowerCase();

  if (!name) {
    return null;
  }

  return {
    name,
    rawArgs,
    args: splitArgs(rawArgs)
  };
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }

      if (char === "\\" && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
        continue;
      }

      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\" && index + 1 < input.length) {
      current += input[index + 1];
      index += 1;
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}
