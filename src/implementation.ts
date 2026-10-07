/** Locate compiler sources in a checkout or their JavaScript release equivalents. */
export function implementationFile(file: string, parent: string): URL {
  if (file.startsWith('@bedrock-core/')) {
    return new URL(import.meta.resolve(file.replace(/\.ts$/, '')));
  }

  return new URL(parent.endsWith('.js') ? file.replace(/\.ts$/, '.js') : file, parent);
}
