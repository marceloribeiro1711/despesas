# Despesas de Casa — pacote de instalação

## O que tem aqui
```
index.html              → o app (PWA completo)
manifest.json           → metadados do PWA (nome, ícones, cor)
service-worker.js       → cache offline (network-first)
icons/                  → ícones do app (192, 512, maskable)
firebase/
  firestore.rules       → regras de segurança do banco
  firestore.indexes.json→ índice necessário para as consultas do app
  firebase.json         → config pro Firebase CLI
```

## 1. Configurar o Firebase (banco de dados)

1. Crie um projeto em https://console.firebase.google.com (se ainda não tiver)
2. Ative **Firestore Database** (modo produção) e **Authentication → Sign-in method → Anônimo**
3. Em *Configurações do projeto → Seus apps → Web*, copie o objeto de config e cole em `index.html`, no bloco `firebaseConfig` (dentro do `<script type="module">`, procure por `SUA_API_KEY`)
4. Publicar as regras e o índice — com o [Firebase CLI](https://firebase.google.com/docs/cli) instalado:
   ```bash
   npm install -g firebase-tools
   firebase login
   cd firebase
   firebase use --add        # selecione o projeto criado no passo 1
   firebase deploy --only firestore:rules,firestore:indexes
   ```
   Isso evita ter que esperar o app pedir o índice sozinho na primeira consulta (o que também funciona, só demora ~2 min).

## 2. Publicar no GitHub Pages

Copie estes 4 itens pra raiz do seu repositório (do jeito que já faz com o PSC PRO / Free):
```
index.html
manifest.json
service-worker.js
icons/
```
Commit, push, e confirme que o GitHub Pages está servindo a branch/pasta certa.

## 3. Gerar o pacote Android (TWA)

1. Acesse https://www.pwabuilder.com
2. Cole a URL do GitHub Pages
3. Gere o pacote Android (TWA) e baixe

## Versionamento

Sempre que subir uma nova versão, sincronize os **dois** pontos (mesmo padrão dos outros apps):
- `APP_VERSION` no `<script>` no final do `index.html`
- `CACHE_VERSION` no topo do `service-worker.js`

Esquecer de sincronizar os dois é a causa mais comum de tela presa em versão antiga depois do deploy.

## Estrutura dos dados no Firestore

```
/households/{householdId}/expenses/{autoId}
    pagador: "LUCIANA" | "MARCELO"
    categoria: string (chave, ex: "mercado")
    categoriaLabel: string (rótulo exibido, ex: "Mercado")
    descricao: string (opcional)
    valorCents: number (valor em centavos)
    data_despesa: string "YYYY-MM-DD" (data escolhida pelo usuário)
    criado_em: Timestamp (data de inclusão — usada em listagens e relatórios)
```

`householdId` é definido pela constante `HOUSEHOLD_ID` no `index.html` (hoje: `"familia-marcelo"`) — pode trocar antes do primeiro uso, mas depois não, ou os dados antigos "somem" (ficam noutro caminho do banco).
