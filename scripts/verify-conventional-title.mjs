const title = process.env.PR_TITLE?.trim() ?? "";
const conventional = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: .+$/;
if (!conventional.test(title)) {
  process.stderr.write(`Pull request title must use Conventional Commits syntax, for example "feat: add graph filtering". Received: ${title || "(empty)"}\n`);
  process.exit(1);
}
