/** UI release that supplies a shared pack with this manifest version. */
export function resourcePackReleaseVersion(packVersion: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(packVersion);

  if (!match || Number(match[1]) < 1) {
    throw new Error('The shared resource pack must declare an exact version with major >= 1');
  }

  return `${Number(match[1]) - 1}.${match[2]}.${match[3]}${match[4] ?? ''}${match[5] ?? ''}`;
}

export const UI_RESOURCE_PACK_UUID = '761ecd37-ad1c-4a64-862a-d6cc38767426';
