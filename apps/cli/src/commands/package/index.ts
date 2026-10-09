import type { CommandRegistry } from '../../command-registry.js';
import { printResult } from '../../command-result.js';
import { requireFlag } from '../../flags.js';
import { initCommand } from './init.js';
import { buildCommand } from './build.js';
import { packCommand } from './pack.js';
import { inspectCommand, inspectInstalledCommand } from './inspect.js';
import { verifyCommand } from './verify.js';
import { installCommand } from './install.js';
import { lockCommand } from './lock.js';
import { uninstallCommand } from './uninstall.js';
import { diffCommand } from './diff.js';
import { fingerprintCommand } from './fingerprint.js';

const SUBSYSTEM = 'package';

/**
 * Registers every command backed by `@xo/package-sdk`: `init`, `build`,
 * `pack`, `inspect`, `verify`, `install`, `uninstall`, `diff`,
 * `fingerprint`. This module owns all argument-shape decisions for these commands
 * (which flags exist, which are required) — `index.ts` never sees any of
 * that; it only ever calls this file's `registerCommands()`.
 */
export function registerCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'init',
    subsystem: SUBSYSTEM,
    usage: 'xo init <dir> --name <name> --creator-did <did> [--version <v>] [--format-version <v>]\n                                         Scaffold a new package project',
    run: async (args) => {
      const dir = args.positionals[0];
      const name = requireFlag(args.flags, 'name');
      const creatorDid = requireFlag(args.flags, 'creator-did');
      const version = requireFlag(args.flags, 'version');
      const formatVersion = requireFlag(args.flags, 'format-version');
      if (!dir || !name || !creatorDid) {
        process.stdout.write('xo init <dir> --name <name> --creator-did <did> [--version <v>] [--format-version <v>]\n');
        return 1;
      }
      return printResult(
        await initCommand({
          dir,
          name,
          creatorDid,
          ...(version !== undefined ? { version } : {}),
          ...(formatVersion !== undefined ? { formatVersion } : {}),
        }),
      );
    },
  });

  registry.register({
    name: 'build',
    subsystem: SUBSYSTEM,
    usage: 'xo build <dir> [--out <file.xo>] [--sign] [--signer-did <did>] [--key-out <prefix>]\n                                         Build, (optionally) sign, validate, and pack a project',
    run: async (args) => {
      const dir = args.positionals[0];
      const out = requireFlag(args.flags, 'out');
      const signerDid = requireFlag(args.flags, 'signer-did');
      const keyOut = requireFlag(args.flags, 'key-out');
      if (!dir) {
        process.stdout.write('xo build <dir> [--out <file.xo>] [--sign] [--signer-did <did>] [--key-out <prefix>]\n');
        return 1;
      }
      return printResult(
        await buildCommand({
          dir,
          sign: args.flags['sign'] === true,
          ...(out !== undefined ? { out } : {}),
          ...(signerDid !== undefined ? { signerDid } : {}),
          ...(keyOut !== undefined ? { keyOut } : {}),
        }),
      );
    },
  });

  registry.register({
    name: 'pack',
    subsystem: SUBSYSTEM,
    usage: 'xo pack <path> [--out <file.xo>] [--sign] [--signer-did <did>] [--key-out <prefix>]\n                                         Build a signed .xo package and print a name/version/fingerprint/component summary',
    run: async (args) => {
      const dir = args.positionals[0];
      const out = requireFlag(args.flags, 'out');
      const signerDid = requireFlag(args.flags, 'signer-did');
      const keyOut = requireFlag(args.flags, 'key-out');
      if (!dir) {
        process.stdout.write('xo pack <path> [--out <file.xo>] [--sign] [--signer-did <did>] [--key-out <prefix>]\n');
        return 1;
      }
      return printResult(
        await packCommand({
          dir,
          sign: args.flags['sign'] === true,
          ...(out !== undefined ? { out } : {}),
          ...(signerDid !== undefined ? { signerDid } : {}),
          ...(keyOut !== undefined ? { keyOut } : {}),
        }),
      );
    },
  });

  registry.register({
    name: 'inspect',
    subsystem: SUBSYSTEM,
    usage:
      'xo inspect <archive.xo>                  Print a human-readable summary of a package\n' +
      '    xo inspect <name>@<version> --store <dir>  Print an installed package\'s dependencies and xo.lock freshness',
     run: async (args) => {
      const target = args.positionals[0];
      const storeDir = requireFlag(args.flags, 'store');
      if (!target) {
        process.stdout.write('xo inspect <archive.xo>\nxo inspect <name>@<version> --store <dir>\n');
        return 1;
      }
      // --store present -> `target` is "<name>@<version>" of an already-
      // installed package (see inspectInstalledCommand's doc comment for
      // why this lives on `inspect` rather than `verify`); otherwise
      // `target` is an archive path, exactly as before this flag existed.
      if (storeDir !== undefined) {
        return printResult(await inspectInstalledCommand({ nameAtVersion: target, storeDir }));
      }
      return printResult(await inspectCommand(target));
    },
  });

  registry.register({
    name: 'verify',
    subsystem: SUBSYSTEM,
    usage: 'xo verify <archive.xo> [--pubkey <did>=<path/to/key.pem>]...\n                                         Validate schema, hashes, Merkle root, and signatures',
    run: async (args) => {
      const archivePath = args.positionals[0];
      if (!archivePath) {
        process.stdout.write('xo verify <archive.xo> [--pubkey <did>=<path/to/key.pem>]...\n');
        return 1;
      }
      return printResult(await verifyCommand({ archivePath, pubkeySpecs: args.flagLists['pubkey'] ?? [] }));
    },
  });

  registry.register({
    name: 'install',
    subsystem: SUBSYSTEM,
    usage:
      'xo install <archive.xo> --store <dir> [--force] [--skip-resolution]\n' +
      '                                         Install a package into a local store, resolving and locking\n' +
      '                                         its declared dependencies (against what\'s already in --store)\n' +
      '                                         unless --skip-resolution is given',
     run: async (args) => {
      const archivePath = args.positionals[0];
      const storeDir = requireFlag(args.flags, 'store');
      if (!archivePath || !storeDir) {
        process.stdout.write('xo install <archive.xo> --store <dir> [--force] [--skip-resolution]\n');
        return 1;
      }
      return printResult(
        await installCommand({
          archivePath,
          storeDir,
          force: args.flags['force'] === true,
          skipResolution: args.flags['skip-resolution'] === true,
        }),
      );
    },
  });

  registry.register({
    name: 'lock',
    subsystem: SUBSYSTEM,
    usage: 'xo lock <name>@<version> --store <dir>    Re-resolve and (over)write an installed package\'s xo.lock',
    run: async (args) => {
      const nameAtVersion = args.positionals[0];
      const storeDir = requireFlag(args.flags, 'store');
      if (!nameAtVersion || !storeDir) {
        process.stdout.write('xo lock <name>@<version> --store <dir>\n');
         return 1;
       }
      return printResult(await lockCommand({ nameAtVersion, storeDir }));
     },
   });
        

  registry.register({
    name: 'uninstall',
    subsystem: SUBSYSTEM,
    usage: 'xo uninstall <name>@<version> --store <dir>\n                                         Remove an installed package from a local store',
    run: async (args) => {
      const nameAtVersion = args.positionals[0];
      const storeDir = requireFlag(args.flags, 'store');
      if (!nameAtVersion || !storeDir) {
        process.stdout.write('xo uninstall <name>@<version> --store <dir>\n');
        return 1;
      }
      return printResult(await uninstallCommand({ nameAtVersion, storeDir }));
    },
  });

  registry.register({
    name: 'diff',
    subsystem: SUBSYSTEM,
    usage: 'xo diff <from.xo> <to.xo>                Compare two packages and print an upgrade plan',
    run: async (args) => {
      const [fromPath, toPath] = args.positionals;
      if (!fromPath || !toPath) {
        process.stdout.write('xo diff <from.xo> <to.xo>\n');
        return 1;
      }
      return printResult(await diffCommand({ fromPath, toPath }));
    },
  });

  registry.register({
    name: 'fingerprint',
    subsystem: SUBSYSTEM,
    usage: 'xo fingerprint <archive.xo>              Print a package\'s content fingerprint',
    run: async (args) => {
      const archivePath = args.positionals[0];
      if (!archivePath) {
        process.stdout.write('xo fingerprint <archive.xo>\n');
        return 1;
      }
      return printResult(await fingerprintCommand(archivePath));
    },
  });
}
