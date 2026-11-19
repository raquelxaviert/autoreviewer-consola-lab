# Experimento: análise estática vs. análise híbrida (estática + LLM)

## Pergunta

O LLM identifica problemas de manutenibilidade que ESLint e TypeScript Compiler não detectam, **sem** gerar uma
quantidade excessiva de falsos positivos?

## Objeto e versão

- Código-alvo: `src/` de [unjs/consola](https://github.com/unjs/consola) em `c47faac1738b7383971c6c20b5a34ffa15e7cc3b`.
- Base dos cenários: `experiment-base` em `e56278206e4852b5db8813835cb92c0862ebe123` (Consola original + ferramenta).
- Configuração de ESLint e `tsconfig.json` do projeto **sem alteração de regras**. A regra `no-unused-vars` está
  desabilitada no projeto e por isso não foi usada.
- Validação inicial (Node 22.16, pnpm 10): `eslint src` sem achados; `tsc --noEmit` com 2 erros preexistentes
  (`printj` sem tipos; tipos do `vite` em `node_modules`); `vitest` 3/3 testes passando; Prettier ok.

## Dataset (15 PRs)

Cada cenário é uma branch `scenario/prXX-*` criada por `scripts/create-scenarios.mjs` diretamente a partir do mesmo
commit-base, com um único commit pequeno sobre código real do Consola (1 arquivo por cenário). Os patches estão em
`experiments/scenarios/`.

| ID | Problema introduzido | Arquivo | Detector esperado |
|---|---|---|---|
| pr01 | `formatDate(Date.now())`: `number` onde se espera `Date` | `src/reporters/fancy.ts` | TypeScript |
| pr02 | `formatTree(): string` passa a retornar `string[]` | `src/utils/tree.ts` | TypeScript |
| pr03 | `let` nunca reatribuído (`prefer-const`) | `src/utils/format.ts` | ESLint |
| pr04 | `forEach` no despacho de reporters (`unicorn/no-array-for-each`) | `src/consola.ts` | ESLint |
| pr05 | `formatBoxTitle` copia `characterFormat` | `src/reporters/fancy.ts` | LLM |
| pr06 | `shouldUseBadge`: if/else aninhado com 4 níveis | `src/reporters/fancy.ts` | LLM |
| pr07 | throttling com nomes `fn/flag/n/tmp/d/s/x` | `src/consola.ts` | LLM |
| pr08 | `_logFn` passa a formatar e escrever saída | `src/consola.ts` | LLM |
| pr09 | núcleo importa `FancyReporter` e usa `instanceof` | `src/consola.ts` | LLM |
| pr10 | verificações redundantes em `isLogObj` | `src/utils/log.ts` | LLM |
| pr11 | `JSON.stringify` duplicado no caminho de todo log | `src/consola.ts` | LLM |
| pr12 | `catch` vazio ao chamar reporters | `src/consola.ts` | LLM |
| pr13 | extração correta de `getTypeColor` (controle) | `src/reporters/fancy.ts` | nenhum |
| pr14 | remoção de `as any` em mapas tipados (controle) | `src/reporters/fancy.ts` | nenhum |
| pr15 | `leftAlign` passa a respeitar a JSDoc (controle) | `src/utils/string.ts` | nenhum |

O gabarito (`experiments/ground-truth.json`) foi escrito a partir das alterações introduzidas, **antes** de executar
qualquer ferramenta nos cenários, com arquivo, intervalo de linhas, categoria, categorias aceitas e ferramenta esperada.
Controles têm lista de problemas vazia.

## Procedimento

1. `scripts/run-experiment.mjs` faz checkout de cada branch em um worktree isolado (`experiments/work/lab`).
2. `collect` executa ESLint (`--format json`) e `tsc --noEmit --pretty false` no head e no merge-base.
3. `review` (dry-run) obtém o diff (Octokit quando os PRs existem, ou `git diff` equivalente), atribui os
   diagnósticos ao PR e chama o Gemini **uma vez** por cenário. A partir **da mesma execução** derivam-se:
   - **static** = achados ESLint + TypeScript;
   - **hybrid** = static + recomendações do LLM que sobrevivem à validação e à deduplicação.
   Assim as duas modalidades usam o mesmo commit, o mesmo diff e os mesmos diagnósticos estáticos.
4. `evaluate` calcula as métricas e gera `experiments/results/{static.json,hybrid.json,comparison.csv,summary.md}`.

Parâmetros do LLM: `temperature: 0`, saída JSON com `responseSchema`, ≤ 5 recomendações, diff anotado com números de
linha (≤ 16.000 caracteres) + trechos do arquivo novo (±15 linhas ao redor das mudanças, ≤ 8.000 caracteres) + lista de
achados estáticos. O conteúdo do PR é delimitado em `<pr_data>` e declarado como dado não confiável.

## Critérios de avaliação

- **TP**: achado no mesmo arquivo, com linha em `[início − 3, fim + 3]` do problema esperado e categoria em
  `acceptedCategories`. Cada problema esperado é creditado **no máximo uma vez**; achados estáticos são casados antes dos do LLM.
- **Duplicata**: achado que casaria com um problema já creditado (não conta como TP nem como FP; reportado à parte).
- **FP**: achado que não corresponde a nenhum problema esperado (inclui qualquer achado em controles negativos).
- **FN**: problema esperado sem achado correspondente.
- Precisão = TP/(TP+FP); Recall = TP/(TP+FN); agregação micro (somatório sobre os cenários). Denominador zero ⇒ `N/A`.
- Tempo: modalidade estática = ESLint + tsc em head e base; híbrida = estática + chamadas ao Gemini.
- Categorias aceitas (decididas a priori): `refactoring` é aceita como categoria genérica nos cenários de manutenibilidade;
  pares próximos são aceitos onde o problema realmente se sobrepõe (coesão↔acoplamento em pr08/pr09;
  duplicação/complexidade em pr10/pr11). Correspondência textual da explicação **não** é usada.
- **Adjudicação manual** (`experiments/adjudication.json`): permitida só para achados que a regra automática não
  consegue classificar corretamente (ex.: problema arquitetural apontado em linha adicionada fora do intervalo), sempre com
  justificativa escrita; o arquivo é versionado e aplicado pelo `evaluate`.

## Reprodução

```bash
git checkout experiment-base
pnpm install --frozen-lockfile
pnpm --dir tools/autoreviewer install --frozen-lockfile && pnpm --dir tools/autoreviewer build
node scripts/create-scenarios.mjs            # recria as 15 branches (commits novos, mesmo conteúdo)
export GEMINI_API_KEY=...  GEMINI_MODEL=gemini-2.5-flash
node scripts/run-experiment.mjs              # ou --diff-source github com GITHUB_TOKEN/GITHUB_REPOSITORY + experiments/prs.json
pnpm --dir tools/autoreviewer evaluate
```

## Ameaças à validade

- Cenários criados pelos próprios autores: problemas são pequenos e localizados, mais fáceis que em PRs reais.
- 15 PRs e uma execução do LLM por cenário: amostra pequena, sem análise de variância entre execuções.
- O LLM vê o diff e trechos locais, não o repositório inteiro; a categoria escolhida pelo modelo pode divergir do gabarito.
- A tolerância de linhas e as categorias aceitas influenciam TP/FP; por isso são fixadas a priori e documentadas.
