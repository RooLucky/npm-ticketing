import { Command, Option } from "commander";
import { config as loadEnvironment } from "dotenv";
import path from "node:path";
import { CliError } from "./errors.js";
import { initProject } from "./install.js";
import type {
  InitOptions,
  InstallerDependencies,
  PackageManager,
  TicketingMode,
} from "./types.js";

type CommanderInitOptions = {
  cwd: string;
  mode?: TicketingMode;
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

function migrationCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case "pnpm":
      return "pnpm exec ticketing migrate --cwd .";
    case "yarn":
      return "yarn exec ticketing migrate --cwd .";
    case "bun":
      return "bun run ticketing migrate --cwd .";
    case "npm":
      return "npm exec -- ticketing migrate --cwd .";
  }
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
    .addOption(
      new Option(
        "--mode <mode>",
        "ticketing backend mode (defaults to connected on first install)",
      ).choices(["connected", "self-hosted"]),
    )
    .option("--yes", "accept safe defaults and overwrite confirmation", false)
    .option("--dry-run", "show planned files and commands without changing anything", false)
    .option("--overwrite", "allow replacement of locally modified generated files", false)
    .option("--skip-install", "generate files without running dependency or shadcn commands", false)
    .action(async (rawOptions: CommanderInitOptions) => {
      const options: InitOptions = {
        cwd: path.resolve(rawOptions.cwd),
        ...(rawOptions.mode ? { mode: rawOptions.mode } : {}),
        yes: rawOptions.yes,
        dryRun: rawOptions.dryRun,
        overwrite: rawOptions.overwrite,
        skipInstall: rawOptions.skipInstall,
      };
      const result = await initProject(options, dependencies);
      if (result.mode === "self-hosted") {
        dependencies.logger.info("");
        dependencies.logger.info(
          `After setting the self-hosted variables, run: ${migrationCommand(result.project.packageManager)}`,
        );
        dependencies.logger.info(
          "Self-hosted mode ignores TICKETING_API_URL; you may remove a legacy value from .env.example and your server environment.",
        );
      }
      dependencies.logger.info("");
      dependencies.logger.info(usageExample(result.project.importAlias));
    });

  program
    .command("migrate")
    .description("Apply safe @quanby/ticketing PostgreSQL schema migrations")
    .addOption(
      new Option("--cwd <directory>", "Next.js project directory").default(process.cwd()),
    )
    .action(async (rawOptions: { cwd: string }) => {
      const cwd = path.resolve(rawOptions.cwd);
      for (const fileName of [".env.local", ".env"]) {
        loadEnvironment({
          path: path.join(cwd, fileName),
          override: false,
          quiet: true,
        });
      }
      const databaseUrl = process.env.DATABASE_TICKETING_URL;
      if (!databaseUrl) {
        throw new CliError(
          `DATABASE_TICKETING_URL is required in ${cwd} or the current environment.`,
        );
      }
      const { migrateTicketingDatabase, TicketingDatabaseUrlSchema } = await import(
        "../self-hosted/index.js"
      );
      const parsedDatabaseUrl = TicketingDatabaseUrlSchema.safeParse(databaseUrl);
      if (!parsedDatabaseUrl.success) {
        throw new CliError(
          parsedDatabaseUrl.error.issues[0]?.message ??
            "DATABASE_TICKETING_URL is invalid.",
        );
      }
      const result = await migrateTicketingDatabase({ databaseUrl });
      dependencies.logger.info(
        `Ticketing database schema is ready at version ${result.version}.`,
      );
    });

  return program;
}
