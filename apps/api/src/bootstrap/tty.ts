import { createInterface } from "node:readline/promises";

export async function readVisibleLine(prompt: string) {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
}

export async function readHiddenLine(prompt: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TTY_REQUIRED");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  let onData: (chunk: string) => void;
  try {
    await new Promise<void>((resolve, reject) => {
      onData = (chunk) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            reject(new Error("INTERRUPTED"));
            return;
          }
          if (character === "\r" || character === "\n") {
            resolve();
            return;
          }
          if (character === "\u007f" || character === "\b") {
            value = [...value].slice(0, -1).join("");
          } else if (character >= " ") {
            value += character;
          }
        }
      };
      process.stdin.on("data", onData);
    });
    return value;
  } finally {
    process.stdin.off("data", onData!);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  }
}
