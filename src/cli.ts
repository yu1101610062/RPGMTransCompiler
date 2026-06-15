#!/usr/bin/env node
import {
  installRuntimeCommand,
  pretranslateCommand,
  reportCommand,
  restoreRuntimeCommand,
  runCommand,
  scanCommand,
  validateRuntimeCommand,
  watchCommand
} from "./commands.js";
import { startWebServer } from "./web/server.js";

type Args = { _: string[]; [key: string]: string | boolean | string[] };

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "scan": {
      const source = requiredPos(args, 0, "source root");
      const result = scanCommand(source, {
        targetLang: stringOpt(args, "target", "zh-Hans"),
        out: stringOpt(args, "out"),
        db: stringOpt(args, "db")
      });
      console.log(JSON.stringify({ dbPath: result.dbPath, profile: result.profile }, null, 2));
      break;
    }
    case "install-runtime": {
      const db = requiredPos(args, 0, "project db");
      console.log(JSON.stringify(installRuntimeCommand(db, stringOpt(args, "out")), null, 2));
      break;
    }
    case "restore-runtime": {
      const db = requiredPos(args, 0, "project db");
      console.log(JSON.stringify(restoreRuntimeCommand(db), null, 2));
      break;
    }
    case "watch": {
      const db = requiredPos(args, 0, "project db");
      const provider = stringOpt(args, "provider", "mock")!;
      console.log(JSON.stringify(await watchCommand(db, provider, {
        once: Boolean(args.once),
        pollMs: Number(stringOpt(args, "poll-ms", "500")),
        batchSize: Number(stringOpt(args, "batch-size", "20")),
        concurrency: Number(stringOpt(args, "concurrency", "100")),
        skipTranslated: !Boolean(args["no-skip-translated"])
      }), null, 2));
      break;
    }
    case "pretranslate": {
      const db = requiredPos(args, 0, "project db");
      const provider = stringOpt(args, "provider", "mock")!;
      const mode = stringOpt(args, "mode", "safe");
      if (mode !== "safe") throw new Error(`Unsupported pretranslate mode: ${mode}`);
      console.log(JSON.stringify(await pretranslateCommand(db, provider, {
        mode,
        batchSize: Number(stringOpt(args, "batch-size", "20")),
        concurrency: Number(stringOpt(args, "concurrency", "100")),
        overwrite: Boolean(args.overwrite),
        progress: Boolean(args.progress)
      }), null, 2));
      break;
    }
    case "validate-runtime": {
      const db = requiredPos(args, 0, "project db");
      console.log(JSON.stringify(validateRuntimeCommand(db), null, 2));
      break;
    }
    case "report": {
      const db = requiredPos(args, 0, "project db");
      console.log(JSON.stringify(reportCommand(db, stringOpt(args, "out")), null, 2));
      break;
    }
    case "run": {
      const source = requiredPos(args, 0, "source root");
      const provider = stringOpt(args, "provider", "mock")!;
      console.log(JSON.stringify(await runCommand(source, {
        targetLang: stringOpt(args, "target", "zh-Hans"),
        out: stringOpt(args, "out"),
        provider,
        db: stringOpt(args, "db"),
        once: Boolean(args.once),
        noLaunch: Boolean(args["no-launch"])
      }), null, 2));
      break;
    }
    case "web": {
      const db = requiredPos(args, 0, "project db");
      const port = Number(stringOpt(args, "port", "5177"));
      startWebServer(db, port);
      console.log(`RPGMTransCompiler Web UI: http://127.0.0.1:${port}`);
      break;
    }
    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}

function parseArgs(input: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < input.length; i++) {
    const token = input[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        out[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = input[i + 1];
        if (next && !next.startsWith("--")) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function stringOpt(args: Args, key: string, fallback?: string): string | undefined {
  const value = args[key];
  if (typeof value === "string") return value;
  return fallback;
}

function requiredPos(args: Args, index: number, name: string): string {
  const value = args._[index];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function usage(): void {
  console.log(`Usage:
  rpgmtrans scan SOURCE [--target zh-Hans] [--db DB]
  rpgmtrans install-runtime DB
  rpgmtrans restore-runtime DB
  rpgmtrans watch DB [--provider mock|deepseek|openai] [--once] [--poll-ms 500] [--batch-size 20] [--concurrency 100] [--no-skip-translated]
  rpgmtrans pretranslate DB [--provider mock|deepseek|openai] [--mode safe] [--batch-size 20] [--concurrency 100] [--progress] [--overwrite]
  rpgmtrans validate-runtime DB
  rpgmtrans report DB [--out REPORT_DIR]
  rpgmtrans run SOURCE [--provider mock|deepseek|openai] [--target zh-Hans] [--db DB] [--no-launch]
  rpgmtrans web DB [--port 5177]`);
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
