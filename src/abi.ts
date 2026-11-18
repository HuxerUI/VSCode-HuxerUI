import { Target } from './projects';

export const targetAbis: Record<Target, readonly string[]> = {
  android: ['arm64-v8a', 'x86_64'],
  ios: ['arm64', 'x86_64'],
  linux: ['aarch64', 'x86_64'],
  macos: ['arm64', 'x86_64'],
  web: ['wasm32'],
  windows: ['x86_64'],
};

export function readAbis(target: Target | undefined, value: unknown): string[] | undefined {
  if (!target || !Array.isArray(value) || !value.length ||
      !value.every(abi => typeof abi === 'string' && targetAbis[target].includes(abi))) {
    return undefined;
  }
  return [...new Set<string>(value)];
}

export function selectableAbis(source: boolean): Partial<Record<Target, readonly string[]>> {
  return {
    android: targetAbis.android,
    ios: targetAbis.ios,
    macos: source ? targetAbis.macos : undefined,
    linux: source && process.env.CMAKE_TOOLCHAIN_FILE ? targetAbis.linux : undefined,
  };
}
