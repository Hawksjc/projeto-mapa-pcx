# Sincronizador Google Sheets ↔ PostgreSQL

Aplicação web para sincronizar dados em ambos os sentidos entre Google Sheets e
PostgreSQL (compatível com Supabase). Todo o código-fonte da aplicação está em
**um único arquivo**: `server.js`, organizado internamente por regiões
comentadas (`### REGIAO: ... ###`), conforme exigido.

Testado localmente de ponta a ponta (boot, autenticação, sessão, listagem de
tabelas, preview, upsert, proteção contra SQL injection em identificadores,
exportação de histórico em CSV/PDF) contra uma instância real de PostgreSQL.
A integração com o Google Sheets segue a API oficial (`googleapis`) e foi
revisada com cuidado, mas não pôde ser testada contra uma planilha real neste
ambiente (sem acesso à internet/Google a partir daqui) — teste esse fluxo
assim que configurar suas credenciais.

## 1. Decisões de arquitetura (leia antes de configurar)

- **Acesso a planilhas privadas via Service Account.** Em vez de implementar
  um fluxo OAuth completo por usuário (projeto à parte, com tela de
  consentimento, refresh tokens, etc.), o app usa uma *conta de serviço* do
  Google. Você compartilha cada planilha com o e-mail dessa conta
  (`client_email` do JSON), como faria com qualquer colaborador. É o padrão
  recomendado para ferramentas internas/administrativas como esta.
- **Single file de verdade.** `server.js` contém backend (Express), frontend
  (HTML/CSS/JS embutidos como string), autenticação, acesso a banco e ao
  Sheets. Bibliotecas npm (express, pg, googleapis, etc.) são dependências de
  terceiros, não "módulos próprios" — o requisito trata da ausência de
  divisão do *seu* código em múltiplos arquivos.
- **Sessão em memória.** `express-session` usa armazenamento em memória do
  processo Node. Funciona bem para uma única instância. Se for escalar para
  múltiplas instâncias (load balancer), será necessário um store externo
  (ex.: Redis) — fora do escopo do arquivo único de aplicação, mas é uma
  troca de uma linha de configuração se chegar a esse ponto.
- **Histórico e favoritos persistidos no próprio Postgres** (tabelas
  `sync_history` e `sync_favorites`, criadas automaticamente no boot), para
  sobreviver a reinícios do servidor.
- **Proteção contra SQL Injection em identificadores.** Valores usam sempre
  consultas parametrizadas. Nomes de tabela/coluna (que não podem ser
  parametrizados em SQL) passam por validação estrita (regex) e são
  escapados com `pg-format` antes de entrar em qualquer DDL/DML.
- **Cookies de sessão `secure`.** Em produção, o cookie de sessão só é
  reenviado pelo navegador sobre HTTPS. A maioria das plataformas de deploy
  termina o TLS num proxy — por isso `trust proxy` já vem habilitado por
  padrão em produção. Se o login parecer funcionar mas a sessão "não
  colar", confirme que o acesso está sendo feito via HTTPS.

## 2. Configuração

1. Copie `.env.example` para `.env` e preencha todas as variáveis.
2. Gere o hash da senha do administrador:
   ```
   npm install
   npm run hash-password "sua-senha-aqui"
   ```
   Cole o resultado em `ADMIN_PASSWORD_HASH`.
3. Crie uma Service Account no Google Cloud, ative a **Google Sheets API**,
   gere uma chave JSON e cole o conteúdo (uma linha só) em
   `GOOGLE_SERVICE_ACCOUNT_JSON`.
4. Compartilhe cada planilha que for usar com o `client_email` dessa conta
   (permissão de Editor se for exportar dados para ela).

## 3. Rodando localmente

```
npm install
npm start
```

Acesse `http://localhost:3000`.

## 4. Deploy

Como é um único processo Node (Express), funciona em qualquer plataforma que
rode Node.js 18+ com variáveis de ambiente (Render, Railway, Fly.io, um VPS
com PM2/systemd, etc.):

```
npm install --omit=dev
NODE_ENV=production node server.js
```

Garanta HTTPS (a maioria das plataformas cuida disso automaticamente) e que
`DATABASE_URL` aponte para o Postgres/Supabase de produção.

## 5. O que está implementado

- Fluxo completo Sheets → Postgres: validação de link, teste de acesso,
  seleção de aba com preview, escolha/criação de tabela, mapeamento de
  colunas com detecção de colunas novas, 4 modos de sincronização (inserir
  novos, atualizar, upsert, substituir), progresso em tempo real (SSE),
  relatório final.
- Fluxo completo Postgres → Sheets: seleção de tabela com preview, validação
  de planilha de destino, escolha/criação de aba, 3 modos de exportação
  (substituir, adicionar, atualizar por chave), resumo de confirmação,
  progresso em tempo real, botão para abrir a planilha.
- Autenticação por login com sessão, hashing bcrypt, rate limiting básico
  contra força bruta.
- Histórico completo de sincronizações (persistido), com busca, exportação
  em CSV e PDF.
- Favoritos: salvar uma configuração de sincronização e repeti-la com um
  clique.
- Tema claro/escuro, busca de tabelas e de abas, tratamento de erros com
  mensagens específicas e orientação de correção em cada etapa, logs
  estruturados visíveis na própria interface.

## 6. Limitações conhecidas / próximos passos sugeridos

- **Filtros antes da sincronização** e **importação/exportação
  incremental por timestamp** (além do upsert por chave) não foram
  implementados — o upsert por chave cobre a maior parte do caso de uso
  incremental, mas um filtro visual de linhas antes de enviar ainda não
  existe.
- **Sessão em memória** — ver nota acima sobre múltiplas instâncias.
- **Testes automatizados**: a validação aqui foi manual/exploratória contra
  um Postgres real; não há suíte de testes automatizados incluída.
- Ao inferir tipos de coluna na criação automática de tabelas, o app usa uma
  heurística simples (amostra de valores). Revise os tipos gerados antes de
  usar em produção com dados sensíveis.
