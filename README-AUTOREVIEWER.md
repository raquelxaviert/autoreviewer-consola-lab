# AutoReviewer — Revisão automatizada de PRs com análise estática e IA

Trabalho prático de **Manutenção e Evolução de Software (MES/UFMG)**.

O AutoReviewer revisa Pull Requests do GitHub combinando **ESLint**, **TypeScript Compiler** e um **LLM (Gemini)**
focado em manutenibilidade. Ele publica comentários inline e um resumo no PR. Também permite comparar
empiricamente duas modalidades: **estática** (ESLint + tsc) e **híbrida** (estática + LLM).

## Repositório-alvo

Este repositório é uma **cópia experimental** de [unjs/consola](https://github.com/unjs/consola) (licença MIT,
créditos e `LICENSE` originais preservados), uma biblioteca de logging para Node.js e navegadores.

| Item | Valor |
|---|---|
| Commit original do Consola | `c47faac1738b7383971c6c20b5a34ffa15e7cc3b` (v3.4.2, 2026-03-01) |
| Branch-base do experimento | `experiment-base` (commit-base dos cenários: `e56278206e4852b5db8813835cb92c0862ebe123`) |
| Alterações em arquivos do Consola | apenas `eslint.config.mjs` (ignora `tools/`, `scripts/`, `experiments/`, sem alterar regras) e `.gitignore` |

Nenhum PR é aberto em `unjs/consola`.

## Tecnologias

TypeScript, Node.js 22, pnpm, GitHub Actions, Octokit (`@octokit/rest`), ESLint (config original `eslint-config-unjs`),
TypeScript Compiler e a Gemini Developer API (via `fetch` nativo; modelo padrão `gemini-2.5-flash`, configurável).

## Arquitetura

```
PR aberto/atualizado (pull_request → experiment-base)
 ├─ Job 1  static-analysis   (código do PR, SEM segredos, contents: read)
 │    eslint src --format json  +  tsc --noEmit --pretty false
 │    no head do PR e no merge-base  → artifact static-raw.json
 └─ Job 2  review            (código CONFIÁVEL da branch-base; GEMINI_API_KEY; pull-requests: write)
      valida o artifact → Octokit: PR, arquivos e patches (paginado)
      → atribui diagnósticos ao PR (head − base) → diff anotado (≤16k chars) → Gemini (JSON validado)
      → deduplicação → comentários inline (path/line/side=RIGHT/commit_id, ≤8, ```suggestion```) + resumo
```

Módulos em `tools/autoreviewer/src/`:

| Arquivo | Responsabilidade |
|---|---|
| `index.ts` | CLI (`collect`, `review`, `evaluate`) e orquestração; usado igualmente pelo Actions e localmente |
| `static-analysis.ts` | executa ESLint/tsc, converte para o formato unificado, valida artifact, atribui achados ao PR |
| `diff.ts` | parse de hunks (linhas do arquivo novo), filtro de escopo (`src/**/*.ts`), contexto/truncamento, diff via git |
| `llm.ts` | prompt, chamada Gemini, verificação do modelo, validação do JSON, 1 nova tentativa |
| `reviewer.ts` | deduplicação, formatação de comentários/sugestões e do resumo |
| `github.ts` | leitura do PR e publicação (review inline + comentário de resumo atualizável) |
| `evaluate.ts` | correspondência com o gabarito, TP/FP/FN, precisão, recall, tempos, relatórios |

Formato unificado de achado: `source` (`eslint`/`typescript`/`llm`), `file`, `line`, `column`, `rule`, `category`,
`severity`, `message`, `suggestion`, `replacement`, `inDiff`.

**Atribuição ao PR:** um diagnóstico só conta se a sua impressão digital (ferramenta, arquivo, regra, mensagem)
aparece mais vezes no head do que no merge-base. Assim, os 2 erros de tsc preexistentes (ver abaixo) nunca entram
nos resultados. Achados fora das linhas adicionadas (ex.: PR02) vão para o resumo, não para comentários inline.

## Instalação

```bash
corepack enable            # ou pnpm 10 instalado globalmente
pnpm install --frozen-lockfile                 # dependências do Consola
pnpm --dir tools/autoreviewer install --frozen-lockfile
pnpm --dir tools/autoreviewer build
pnpm --dir tools/autoreviewer test             # 16 testes (node:test)
```

## Configuração (variáveis de ambiente / secrets)

| Variável | Uso |
|---|---|
| `GITHUB_REPOSITORY` | `owner/repo` do repositório experimental (automático no Actions) |
| `PR_NUMBER` | número do PR |
| `GITHUB_TOKEN` | token GitHub (no Actions: `secrets.GITHUB_TOKEN`; local: PAT com acesso a PRs do repo) |
| `GEMINI_API_KEY` | chave da Gemini Developer API (no Actions: secret do repositório `GEMINI_API_KEY`) |
| `GEMINI_MODEL` | modelo (padrão `gemini-2.5-flash`; no Actions: variable `GEMINI_MODEL`) |
| `AUTOREVIEWER_MODE` | `hybrid` (padrão) ou `static` |
| `DRY_RUN` | `true` = não publica nada, só JSON + terminal |

No GitHub: *Settings → Secrets and variables → Actions* → secret `GEMINI_API_KEY` (e opcionalmente a variable
`GEMINI_MODEL`). O workflow não precisa de outro token: usa o `GITHUB_TOKEN` com `pull-requests: write` apenas no job 2.

## Execução local

```bash
# 1. análise estática do commit atual contra a base (gera JSON bruto)
node tools/autoreviewer/dist/src/index.js collect --cwd . --base experiment-base --out static-raw.json
# 2a. revisão local (diff via git), sem publicar
DRY_RUN=true GEMINI_API_KEY=... node tools/autoreviewer/dist/src/index.js review --static static-raw.json --diff-source git --out result.json
# 2b. revisão de um PR real (diff via Octokit), publicando comentários
GITHUB_REPOSITORY=owner/autoreviewer-consola-lab PR_NUMBER=5 GITHUB_TOKEN=... GEMINI_API_KEY=... \
  node tools/autoreviewer/dist/src/index.js review --static static-raw.json
```

Scripts equivalentes em `tools/autoreviewer`: `pnpm build`, `pnpm test`, `pnpm collect`, `pnpm review`, `pnpm evaluate`.

## Execução via GitHub Actions

`.github/workflows/autoreviewer.yml` roda em `pull_request` (`opened`, `synchronize`, `reopened`) para PRs com base
`experiment-base` e branch de origem **no próprio repositório** (forks são ignorados). Não usa `pull_request_target`.
O resultado completo fica no artifact `review-result`. Falhas de permissão ao publicar são reportadas como
`::error::` e o job falha.

## PRs experimentais

```bash
node scripts/create-scenarios.mjs --check   # valida que todas as edições aplicam sobre a base
node scripts/create-scenarios.mjs           # (re)cria as 15 branches scenario/prXX-* a partir de experiment-base
git push origin experiment-base 'refs/heads/scenario/*:refs/heads/scenario/*'
for b in $(git branch --format='%(refname:short)' | grep scenario/); do
  gh pr create --base experiment-base --head "$b" --title "$(git log -1 --format=%s $b)" --body "AutoReviewer scenario"
done
```

Os patches de cada cenário ficam em `experiments/scenarios/prXX.patch`; o gabarito em `experiments/ground-truth.json`.

## Métricas

```bash
node scripts/run-experiment.mjs                 # roda os 15 cenários (dry-run) → experiments/results/raw/
node scripts/run-experiment.mjs --static-only   # apenas modalidade estática
pnpm --dir tools/autoreviewer evaluate          # → static.json, hybrid.json, comparison.csv, summary.md
```

Detalhes da metodologia em [`docs/EXPERIMENT.md`](docs/EXPERIMENT.md).

## Limitações conhecidas

- Falhas preexistentes no Consola original: `tsc --noEmit` reporta 2 erros (`printj` sem declaração de tipos em
  `src/utils/format.ts` e um erro de tipos do `vite` em `node_modules`). Eles são descontados pela atribuição head − base.
- No Windows, os testes do Consola (vitest/esbuild) falham se o caminho do projeto passar de ~260 caracteres
  (`spawn esbuild.exe ENOENT`). Defina `ESBUILD_BINARY_PATH` para uma cópia do binário em um caminho curto.
- `@typescript-eslint/no-unused-vars` e outras regras estão desabilitadas na configuração original; os cenários de lint
  usam `prefer-const` e `unicorn/no-array-for-each`, que estão ativas.
- O LLM só pode comentar linhas **adicionadas**; problemas que exigem ver o resto do repositório podem não ser detectados.
- Saídas do LLM não são determinísticas mesmo com `temperature: 0`; a correspondência automática com o gabarito é
  aproximada (arquivo + categoria + intervalo de linhas ± 3). Adjudicações manuais ficam em `experiments/adjudication.json`.
- O job 1 executa `pnpm install` e o coletor a partir do código do PR (sem segredos e com token somente leitura); a saída
  é tratada como dado não confiável no job 2.
