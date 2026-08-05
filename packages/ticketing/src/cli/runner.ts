import { execa } from "execa";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { CommandRunner, Confirm } from "./types.js";

export const defaultRunner: CommandRunner = {
  async run({ command, args, cwd }) {
    await execa(command, args, {
      cwd,
      stdio: "inherit",
      preferLocal: false,
    });
  },
};

export const defaultConfirm: Confirm = async (message) => {
  if (!stdin.isTTY || !stdout.isTTY) {
    return false;
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`${message} (y/N) `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
};
