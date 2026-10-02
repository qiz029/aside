// Pending RSS imports reserve their maximum download size; completed imports
// keep only the actual cached audio charge. Tombstones retain the charge until
// cleanup has removed their objects and cleared metadata.
export const storedAudio = `(SELECT owner_id,size FROM uploads WHERE state IN ('pending','complete')
  UNION ALL SELECT owner_id,COALESCE(json_extract(metadata,'$.podcast.reservedBytes'),0) AS size FROM episodes)`;
export const PODCAST_DOWNLOAD_LIMIT = 256 * 1024 * 1024;
