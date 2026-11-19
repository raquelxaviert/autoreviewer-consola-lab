# Roteiro da apresentação (12 minutos)

## 1. Objetivo e contexto (1 min)
- Revisão de código é cara; ferramentas estáticas pegam erros de tipo e lint, mas não problemas de design.
- Pergunta: um LLM complementa ESLint + tsc em manutenibilidade sem gerar ruído excessivo?
- Alvo: cópia experimental do `unjs/consola` (commit `c47faac`).

## 2. Arquitetura e implementação (3 min)
- Diagrama do README: job 1 (estático, sem segredos) → artifact → job 2 (código confiável da base, Gemini, publicação).
- Formato unificado de achados; atribuição head − merge-base (descarta os 2 erros preexistentes de tsc).
- Diff anotado com números de linha → JSON validado (arquivo alterado, linha adicionada, categoria, tamanho) → 1 nova tentativa.
- Deduplicação, limite de 5 recomendações do LLM / 8 comentários inline, bloco `suggestion`, resumo com marcador `autoreviewer:summary`.
- Mesmo núcleo para CLI (`collect`/`review`/`evaluate`, `DRY_RUN`) e Actions; 16 testes unitários.

## 3. Demonstração de um PR (3 min)
- Abrir um PR de cenário (sugestão: pr12 silent catch ou pr09 coupling) e mostrar a execução do workflow.
- Mostrar o comentário inline do LLM e o resumo (contagens, tempos, modelo).
- Mostrar um PR estático (pr01) com o comentário do TypeScript na linha correta.
- Plano B sem rede: `DRY_RUN=true` local e `experiments/results/raw/prXX.json`.

## 4. Metodologia e resultados (3 min)
- 15 cenários (4 estáticos, 8 de manutenibilidade, 3 controles), gabarito escrito antes da execução.
- Regra de correspondência (arquivo + categoria + linhas ± 3; 1 crédito por problema).
- Tabela agregada de `experiments/results/summary.md`: precisão, recall, FP e tempo das duas modalidades.
- Três exemplos reais: detecção estática, achado exclusivo do LLM e falha/falso positivo do LLM.

## 5. Conclusão e limitações (2 min)
- Responder à pergunta com os números obtidos (sem extrapolar).
- Limitações: dataset pequeno e sintético sobre código real, uma execução por cenário, não determinismo, contexto limitado ao diff.
- Trabalhos futuros: mais PRs reais, múltiplas execuções, custo/latência por PR.
