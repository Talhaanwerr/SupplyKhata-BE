# AGENTS.md

This project is a multi-tenant SaaS boilerplate.

Always follow:
- `.cursor/rules`
- `cursor-pitfalls.md`
- TypeScript strict mode
- NestJS modular architecture
- Next.js App Router architecture
- tenant isolation
- RBAC and permissions
- secure coding practices

Never create tenant-owned backend queries without tenantId.
Never add packages without checking if they are necessary and stable.
Always keep code clean, typed, and production-ready.

When a real bug is fixed, append a short lesson to `cursor-pitfalls.md` so it is not repeated.

When adding or changing features:
1. Inspect existing files first.
2. Follow current naming and structure.
3. Keep changes focused.
4. Mention commands to run after changes.
