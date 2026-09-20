-- Files the published samples under their collections without re-running the
-- paid preparation: the collection is one attribution field, so it is set in
-- place. Generated from content/public-samples.json and content/collections.json;
-- a later prepare run writes the same value through the seed SQL.
-- Apply with:
--   npx wrangler d1 execute asidefm --remote --config wrangler.production.jsonc \
--     --file=content/collect-public-samples.sql

UPDATE episodes SET metadata=json_set(metadata,'$.attribution.collection',json('{"id":"presidential-addresses","title":{"zh":"总统演讲","en":"Presidential Addresses"}}')) WHERE owner_id='official' AND id IN ('jfk-rice-moon','reagan-brandenburg-gate');
UPDATE episodes SET metadata=json_set(metadata,'$.attribution.collection',json('{"id":"longines-chronoscope","title":{"zh":"Longines Chronoscope 访谈","en":"Longines Chronoscope Interviews"}}')) WHERE owner_id='official' AND id IN ('chronoscope-kennedy','chronoscope-warren','chronoscope-moses','chronoscope-byrd');
UPDATE episodes SET metadata=json_set(metadata,'$.attribution.collection',json('{"id":"luxun-nahan","title":{"zh":"鲁迅《呐喊》","en":"Lu Xun: Call to Arms"}}')) WHERE owner_id='official' AND id IN ('luxun-madmans-diary','luxun-ah-q');
