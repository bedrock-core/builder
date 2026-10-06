import path from 'node:path';
import ts from 'typescript';

/** Record the files and missing candidates that can change esbuild resolution. */
export class CompilationDependencies {
  readonly files = new Set<string>();
  private configs = new Map<string, ts.CompilerOptions>();
  private nearest = new Map<string, string | undefined>();
  private explicitConfig?: string;

  constructor(root: string, config?: string) {
    this.explicitConfig = config ? path.resolve(root, config) : undefined;
  }

  candidates(file: string): void {
    this.files.add(file);
    const extension = path.extname(file);
    const stem = ['.js', '.jsx', '.mjs', '.cjs'].includes(extension) ? file.slice(0, -extension.length) : file;

    for (const suffix of ['.tsx', '.ts', '.jsx', '.js', '.css', '.json', '.mts', '.cts']) {
      this.files.add(`${stem}${suffix}`);
      this.files.add(path.join(file, `index${suffix}`));
    }

    this.files.add(path.join(file, 'package.json'));
  }

  private config(directory: string): ts.CompilerOptions {
    let file = this.explicitConfig;

    if (!file) {
      if (this.nearest.has(directory)) {
        file = this.nearest.get(directory);
      } else {
        file = ts.findConfigFile(directory, (candidate) => {
          this.files.add(candidate);

          return ts.sys.fileExists(candidate);
        });
        this.nearest.set(directory, file);
      }
    }

    if (!file) {
      return {};
    }

    if (!this.configs.has(file)) {
      const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, {
        ...ts.sys,
        // File enumeration affects typechecking, not an explicit esbuild entry.
        readDirectory: () => [],
        readFile: (candidate) => {
          this.files.add(candidate);

          return ts.sys.readFile(candidate);
        },
        fileExists: (candidate) => {
          this.files.add(candidate);

          return ts.sys.fileExists(candidate);
        },
        directoryExists: (candidate) => {
          this.files.add(candidate);

          return ts.sys.directoryExists(candidate);
        },
        onUnRecoverableConfigFileDiagnostic() {},
      });

      this.configs.set(file, parsed?.options ?? {});
    }

    return this.configs.get(file)!;
  }

  imports(specifier: string, directory: string): void {
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      this.candidates(path.resolve(directory, specifier));

      return;
    }

    const config = this.config(directory);
    const base = config.baseUrl ?? config.pathsBasePath;

    if (typeof base === 'string') {
      if (config.baseUrl) {
        this.candidates(path.resolve(base, specifier));
      }

      for (const [pattern, destinations] of Object.entries(config.paths ?? {})) {
        const wildcard = pattern.indexOf('*');
        let matched: string | undefined;

        if (wildcard < 0) {
          matched = specifier === pattern ? '' : undefined;
        } else {
          const before = pattern.slice(0, wildcard);
          const after = pattern.slice(wildcard + 1);

          if (specifier.startsWith(before) && specifier.endsWith(after) && specifier.length >= before.length + after.length) {
            matched = specifier.slice(before.length, specifier.length - after.length);
          }
        }

        if (matched !== undefined) {
          destinations.forEach(destination => this.candidates(path.resolve(base, destination.replace('*', matched!))));
        }
      }
    }

    if (specifier.startsWith('#')) {
      this.parents(directory);

      return;
    }

    const parts = specifier.split('/');
    const name = parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

    while (true) {
      const modules = path.join(directory, 'node_modules');

      this.files.add(modules);
      this.files.add(path.join(modules, name));
      this.files.add(path.join(modules, name, 'package.json'));
      this.candidates(path.join(modules, specifier));
      this.files.add(path.join(directory, 'package.json'));
      this.files.add(path.join(directory, '.pnp.cjs'));
      this.files.add(path.join(directory, '.pnp.data.json'));

      const parent = path.dirname(directory);

      if (parent === directory) {
        break;
      }

      directory = parent;
    }
  }

  parents(directory: string): void {
    this.config(directory);

    while (true) {
      this.files.add(path.join(directory, 'package.json'));
      const parent = path.dirname(directory);

      if (parent === directory) {
        break;
      }

      directory = parent;
    }
  }
}
