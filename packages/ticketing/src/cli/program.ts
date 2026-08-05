import { Command, Option } from "commander";
import path from "node:path";
import { initProject } from "./install.js";
import type { InitOptions, InstallerDependencies } from "./types.js";

type CommanderInitOptions = {
  cwd: string;
  yes: boolean;
  dryRun: boolean;
  overwrite: boolean;
  skipInstall: boolean;
};

function usageExample(importAlias: string): string {
  const importRoot = importAlias || "..";
  return [
    "Add the portal to a server page:",
    "",
    `import { Ticketing } from "${importRoot}/components/ticketing";`,
    "",
    "export default async function SupportPage() {",
    "  const user = await getAuthenticatedUser();",
    "",
    "  return (",
    "    <Ticketing",
    "      user={{ id: user.id, name: user.name, email: user.email }}",
    "      sourceSystem=\"your-app\"",
    "    />",
    "  );",
    "}",
  ].join("\n");
}

export function createProgram(dependencies: InstallerDependencies): Command {
  const program = new Command();
  program
    .name("ticketing")
    .description("Install an editable @quanby/ticketing portal into a Next.js application")
    .version(dependencies.packageVersion)
    .showHelpAfterError();

  program
    .command("init")
    .description("Generate the ticketing portal and its secure proxy routes")
    .addOption(
      new Option("--cwd <directory>", "Next.js project directory").default(process.cwd()),
    )
    .option("--yes", "accept safe defaults and overwrite confirmation", false)
    .option("--dry-run", "show planned files and commands without changing anything", false)
    .option("--overwrite", "allow replacement of locally modified generated files", false)
    .option("--skip-install", "generate files without running dependency or shadcn commands", false)
    .action(async (rawOptions: CommanderInitOptions) => {
      const options: InitOptions = {
        cwd: path.resolve(rawOptions.cwd),
        yes: rawOptions.yes,
        dryRun: rawOptions.dryRun,
        overwrite: rawOptions.overwrite,
        skipInstall: rawOptions.skipInstall,
      };
      const result = await initProject(options, dependencies);
      dependencies.logger.info("");
      dependencies.logger.info(usageExample(result.project.importAlias));
    });

  return program;
}
