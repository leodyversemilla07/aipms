-- The agent run's skill list was a native text[]; SQLite has no scalar
-- lists, so the canonical schema stores the list as JSON. The values are
-- unchanged (a JSON array of skill names), and the type now matches every
-- other JSON payload in the schema.
ALTER TABLE "agentRun" ALTER COLUMN "skills" DROP DEFAULT;
ALTER TABLE "agentRun" ALTER COLUMN "skills" TYPE jsonb USING to_jsonb("skills");
ALTER TABLE "agentRun" ALTER COLUMN "skills" SET DEFAULT '[]'::jsonb;
