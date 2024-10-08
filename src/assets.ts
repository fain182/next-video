import * as path from 'node:path';
import { cwd } from 'node:process';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { getVideoConfig } from './config.js';
import { deepMerge, camelCase, isRemote, toSafePath } from './utils/utils.js';
import * as transformers from './providers/transformers.js';

export interface Asset {
  status:
    | 'sourced'
    | 'pending'
    | 'uploading'
    | 'processing'
    | 'ready'
    | 'error';
  originalFilePath: string;
  // TODO: should we add a `filePath` field which would store the file path
  // without the configurable folder? This would allow us to change the folder
  // without having to update the file paths in the assets.
  // filePath?: string;
  provider: string;
  providerMetadata?: {
    [provider: string]: { [key: string]: any };
  };
  poster?: string;
  sources?: AssetSource[];
  blurDataURL?: string;
  size?: number;
  error?: any;
  createdAt: number;
  updatedAt: number;

  // Here for backwards compatibility with older assets.
  externalIds?: {
    [key: string]: string; // { uploadId, playbackId, assetId }
  };

  // Allow any other properties to be added to the asset so properties like
  // `thumbnailTime` can be added to the asset after the client-side transform.
  [x: string]: unknown;
}

export interface AssetSource {
  src: string;
  type?: string;
}

let assetCache : {[key: string]: Asset} = {};

async function loadAsset(apiBaseUrl: string, assetPath:string) {
  console.log("LOAD "+ assetPath)
  console.log("CACHE status" + JSON.stringify(assetCache))
  if (assetPath in assetCache) {
    console.log("HIT " + assetPath)
    return assetCache[assetPath]
  }
  console.log("MISS " + assetPath)

  const assetFetchResult = await fetch(
    `${apiBaseUrl}/${assetPath}`
  )

  if (!assetFetchResult.ok) {
    throw new Error('Asset not found')
  } else {
    const asset = await assetFetchResult.json()
    if (asset.status == "ready") {
      console.log("ADDED " + assetPath)
      assetCache[assetPath] = asset;
    }
    return asset
  }
}

export async function getAsset(filePath: string): Promise<Asset | undefined> {
  const videoConfig = await getVideoConfig();
  const assetConfigPath = await getAssetConfigPath(filePath);
  return loadAsset(videoConfig.apiBaseUrl, assetConfigPath)
}

export async function getAssetConfigPath(filePath: string) {
  return `${await getAssetPath(filePath)}.json`;
}

async function getAssetPath(filePath: string) {
  if (!isRemote(filePath)) return filePath;

  const { folder, remoteSourceAssetPath = defaultRemoteSourceAssetPath } =
    await getVideoConfig();

  if (!folder) throw new Error('Missing video `folder` config.');

  // Add the asset directory and make remote url a safe file path.
  return path.join(folder, remoteSourceAssetPath(filePath));
}

function defaultRemoteSourceAssetPath(url: string) {
  const urlObj = new URL(url);
  // Strip the https from the asset path.
  // Strip the search params from the file path so in most cases it'll
  // have a video file extension and not a query string in the end.
  return toSafePath(decodeURIComponent(`${urlObj.hostname}${urlObj.pathname}`));
}

async function saveAsset(apiBaseUrl: string, assetPath: string, asset: Asset) {
  const bodyRequest = { path: assetPath, asset: JSON.stringify(asset) }
    const assetFetchResult = await fetch(
      apiBaseUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyRequest),
      }
    )

    if (!assetFetchResult.ok) {
      throw new Error(
        `Impossibile salvare video asset, status code: ${assetFetchResult.status}`
      )
    }
}

export async function createAsset(
  filePath: string,
  assetDetails?: Partial<Asset>
) {
  const videoConfig = await getVideoConfig();
  const assetConfigPath = await getAssetConfigPath(filePath);

  let originalFilePath = filePath;
  if (!isRemote(filePath)) {
    originalFilePath = path.relative(cwd(), filePath);
  }

  const newAssetDetails: Asset = {
    status: 'pending', // overwritable
    ...assetDetails,
    originalFilePath,
    provider: videoConfig.provider,
    providerMetadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (!isRemote(filePath)) {
    try {
      newAssetDetails.size = (await stat(filePath))?.size;
    } catch {
      // Ignore error.
    }
  }

  await saveAsset(videoConfig.apiBaseUrl, assetConfigPath, newAssetDetails)

  return newAssetDetails;
}

export async function updateAsset(
  filePath: string,
  assetDetails: Partial<Asset>
) {
  const videoConfig = await getVideoConfig();
  const assetConfigPath = await getAssetConfigPath(filePath);
  const currentAsset = await getAsset(filePath);

  if (!currentAsset) {
    throw new Error(`Asset not found: ${filePath}`);
  }

  let newAssetDetails = deepMerge(currentAsset, assetDetails, {
    updatedAt: Date.now(),
  }) as Asset;

  newAssetDetails = transformAsset(transformers, newAssetDetails);

  await saveAsset(videoConfig.apiBaseUrl, assetConfigPath, newAssetDetails)

  return newAssetDetails;
}

type TransformerRecord = Record<
  string,
  {
    transform: (asset: Asset, props?: any) => Asset;
  }
>;

function transformAsset(transformers: TransformerRecord, asset: Asset) {
  const provider = asset.provider;
  if (!provider) return asset;

  for (let [key, transformer] of Object.entries(transformers)) {
    if (key === camelCase(provider)) {
      return transformer.transform(asset);
    }
  }

  return asset;
}
