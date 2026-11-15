export function getDefaultRepoRoot(): string
export function getPackageVersion(repoRoot?: string): string
export function isSupportedHostTarget(platform?: NodeJS.Platform, arch?: string): boolean
export function hostAssetName(platform?: NodeJS.Platform, arch?: string): string
export function getReleaseBaseUrl(version?: string): string
export function getHostCacheDir(version?: string, platform?: NodeJS.Platform): string
export function getCachedHostBinaryPath(platform?: NodeJS.Platform, arch?: string, version?: string): string
export function resolveHostBinarySync(repoRoot?: string, platform?: NodeJS.Platform, arch?: string): string | null
export function parseSha256Sums(text: string): Map<string, string>
export function downloadHostBinary(options?: {
  platform?: NodeJS.Platform
  arch?: string
  repoRoot?: string
  version?: string
  baseUrl?: string
  destPath?: string
}): Promise<string>
