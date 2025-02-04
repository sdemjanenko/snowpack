import cacache from 'cacache';
import PQueue from 'p-queue';
import chalk from 'chalk';
import validatePackageName from 'validate-npm-package-name';
import {SnowpackConfig} from './config.js';
import {InstallTarget} from './scan-imports.js';
import {fetchCDNResource, ImportMap, PIKA_CDN, RESOURCE_CACHE, HAS_CDN_HASH_REGEX} from './util.js';

/**
 * Given an install specifier, attempt to resolve it from the CDN.
 * If no lockfile exists or if the entry is not found in the lockfile, attempt to resolve
 * it from the CDN directly. Otherwise, use the URL found in the lockfile and attempt to
 * check the local cache first.
 *
 * All resolved URLs are populated into the local cache, where our internal Rollup engine
 * will load them from when it installs your dependencies to disk.
 */
async function resolveDependency(
  installSpecifier: string,
  packageSemver: string,
  lockfile: ImportMap | null,
  canRetry = true,
): Promise<null | string> {
  // Right now, the CDN is only for top-level JS packages. The CDN doesn't support CSS,
  // non-JS assets, and has limited support for deep package imports. Snowpack
  // will automatically fall-back any failed/not-found assets from local
  // node_modules/ instead.
  if (!validatePackageName(installSpecifier).validForNewPackages) {
    return null;
  }

  // Grab the installUrl from our lockfile if it exists, otherwise resolve it yourself.
  let installUrl: string;
  let installUrlType: 'pin' | 'lookup';
  if (lockfile && lockfile.imports[installSpecifier]) {
    installUrl = lockfile.imports[installSpecifier];
    installUrlType = 'pin';
  } else {
    if (packageSemver === 'latest') {
      console.warn(
        `warn(${installSpecifier}): Not found in "dependencies". Using latest package version...`,
      );
    }
    if (packageSemver.startsWith('npm:@reactesm') || packageSemver.startsWith('npm:@pika/react')) {
      throw new Error(
        `React workaround packages no longer needed! Revert to the official React & React-DOM packages.`,
      );
    }
    if (packageSemver.includes(' ') || packageSemver.includes(':')) {
      console.warn(
        `warn(${installSpecifier}): Can't fetch complex semver "${packageSemver}" from remote CDN.`,
      );
      return null;
    }
    installUrlType = 'lookup';
    installUrl = `${PIKA_CDN}/${installSpecifier}@${packageSemver}`;
  }

  // Hashed CDN urls never change, so its safe to grab them directly from the local cache
  // without a network request.
  if (installUrlType === 'pin') {
    const cachedResult = await cacache.get.info(RESOURCE_CACHE, installUrl).catch(() => null);
    if (cachedResult) {
      if (cachedResult.metadata) {
        const {pinnedUrl} = cachedResult.metadata;
        return pinnedUrl;
      }
    }
  }

  // Otherwise, resolve from the CDN remotely.
  const {statusCode, headers, body} = await fetchCDNResource(installUrl);
  if (statusCode !== 200) {
    console.warn(`Failed to resolve [${statusCode}]: ${installUrl} (${body})`);
    console.warn(`Falling back to local copy...`);
    return null;
  }
  if (installUrlType === 'pin') {
    const pinnedUrl = installUrl;
    await cacache.put(RESOURCE_CACHE, pinnedUrl, body, {
      metadata: {pinnedUrl},
    });
    return pinnedUrl;
  }
  let importUrlPath = headers['x-import-url'] as string;
  let pinnedUrlPath = headers['x-pinned-url'] as string;
  const buildStatus = headers['x-import-status'] as string;
  if (pinnedUrlPath) {
    const pinnedUrl = `${PIKA_CDN}${pinnedUrlPath}`;
    await cacache.put(RESOURCE_CACHE, pinnedUrl, body, {
      metadata: {pinnedUrl},
    });
    return pinnedUrl;
  }
  if (buildStatus === 'SUCCESS') {
    console.warn(`Failed to lookup [${statusCode}]: ${installUrl}`);
    console.warn(`Falling back to local copy...`);
    return null;
  }
  if (!canRetry || buildStatus === 'FAIL') {
    console.warn(`Failed to build: ${installSpecifier}@${packageSemver}`);
    console.warn(`Falling back to local copy...`);
    return null;
  }
  console.log(
    chalk.cyan(
      `Building ${installSpecifier}@${packageSemver}... (This takes a moment, but will be cached for future use)`,
    ),
  );
  if (!importUrlPath) {
    throw new Error('X-Import-URL header expected, but none received.');
  }
  const {statusCode: lookupStatusCode} = await fetchCDNResource(importUrlPath);
  if (lookupStatusCode !== 200) {
    throw new Error(`Unexpected response [${lookupStatusCode}]: ${PIKA_CDN}${importUrlPath}`);
  }
  return resolveDependency(installSpecifier, packageSemver, lockfile, false);
}

export async function resolveTargetsFromRemoteCDN(
  installTargets: InstallTarget[],
  lockfile: ImportMap | null,
  pkgManifest: any,
  config: SnowpackConfig,
) {
  const downloadQueue = new PQueue({concurrency: 16});
  const newLockfile: ImportMap = {imports: {}};
  let resolutionError: Error | undefined;

  const allInstallSpecifiers = new Set(installTargets.map((dep) => dep.specifier));
  for (const installSpecifier of allInstallSpecifiers) {
    const installSemver: string =
      (config.webDependencies || {})[installSpecifier] ||
      (pkgManifest.webDependencies || {})[installSpecifier] ||
      (pkgManifest.dependencies || {})[installSpecifier] ||
      (pkgManifest.devDependencies || {})[installSpecifier] ||
      (pkgManifest.peerDependencies || {})[installSpecifier] ||
      'latest';
    downloadQueue.add(async () => {
      try {
        const resolvedUrl = await resolveDependency(installSpecifier, installSemver, lockfile);
        if (resolvedUrl) {
          newLockfile.imports[installSpecifier] = resolvedUrl;
        }
      } catch (err) {
        resolutionError = resolutionError || err;
      }
    });
  }

  await downloadQueue.onIdle();
  if (resolutionError) {
    throw resolutionError;
  }

  return newLockfile;
}

export function clearCache() {
  return cacache.rm.all(RESOURCE_CACHE);
}
