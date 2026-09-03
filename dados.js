/*
    dados.js
    ---------
    Busca as sessões (Esportes, Eventos, Retratos) direto de uma planilha
    do Google Sheets publicada na web como CSV. Usado por esportes.html,
    eventos.html, retratos.html e galeria.html.

    COMO CONFIGURAR A PLANILHA:
    1. Crie uma planilha no Google Sheets com esta linha de cabeçalho na primeira linha:
       slug | categoria | cliente | titulo | local | data | capa | fotos | senha

       - slug:      identificador único, sem espaço/acento (ex: corrida-noturna-joao)
       - categoria: exatamente "Esportes", "Eventos" ou "Retratos"
       - cliente:   nome que aparece como etiqueta pequena (ex: João Pedro)
       - titulo:    título da sessão (ex: Corrida Noturna do Parque)
       - local:     ex: Cuiabá, MT
       - data:      ex: Setembro 2026
       - capa:      link de UMA foto (pode ser link de arquivo do Drive) usada
                     como capa do card. Se deixar em branco, usa a primeira
                     foto da pasta automaticamente.
       - fotos:     o link de uma PASTA do Google Drive com as fotos da sessão
                     (ex: https://drive.google.com/drive/folders/XXXXXXXX).
                     A pasta precisa estar compartilhada como
                     "Qualquer pessoa com o link - Leitor".
                     (Também aceita, como antes, uma lista de links diretos
                     separados por vírgula, se preferir não usar pasta.)
       - senha:     opcional. Se preenchida, a sessão fica ESCONDIDA — não
                     aparece na página da categoria nem na home, e as fotos
                     só são buscadas depois que o cliente digitar a senha
                     certa em galeria.html (só quem tem o link direto com
                     o slug consegue chegar nela).

                     IMPORTANTE: cole aqui o HASH da senha, não a senha em
                     texto puro (a planilha é publicada como CSV público, e
                     qualquer texto puro nela pode ser lido por qualquer
                     pessoa). Use a página gerar-senha.html incluída no
                     site para transformar a senha desejada em hash antes
                     de colar na planilha.

    2. No Google Sheets: Arquivo > Compartilhar > Publicar na web > selecione a
       aba > formato "Valores separados por vírgula (.csv)" > Publicar.
       Copie o link gerado (termina em "output=csv").

    IMPORTANTE — SOBRE O LINK DA PLANILHA:
    O link real da planilha NÃO fica mais aqui neste arquivo. Ele fica
    guardado só dentro do Cloudflare Worker (veja worker.js), que é
    quem de fato busca o CSV. Este arquivo só chama o Worker através
    da constante SHEET_PROXY_URL logo abaixo — assim, quem inspecionar
    o código do site não descobre o link da planilha.
    Siga as instruções no topo de worker.js para publicar o Worker,
    depois cole a URL dele em SHEET_PROXY_URL.

    COMO CONFIGURAR A CHAVE DO GOOGLE DRIVE (necessária para ler as pastas):
    1. Acesse console.cloud.google.com, crie um projeto (ou use um existente).
    2. Vá em "APIs e serviços" > "Biblioteca", procure "Google Drive API" e ative.
    3. Vá em "APIs e serviços" > "Credenciais" > "Criar credenciais" > "Chave de API".
    4. Copie a chave gerada e cole abaixo em DRIVE_API_KEY.
    5. (Recomendado) Restrinja a chave para funcionar só com a Google Drive API
       e só a partir do domínio do seu site, em "Restrições de aplicativo".
*/

// >>> Cole aqui a URL do seu Cloudflare Worker (ver instruções em worker.js) <<<
const SHEET_PROXY_URL = "https://implantar.sheldon-dias23.workers.dev/";
const DRIVE_API_KEY = "AIzaSyA7-Q5nHRW6g1pQOFN2p7ugx_RgoC7urBE";

// Lê um texto CSV (lidando com campos entre aspas que contêm vírgulas) e
// devolve uma lista de objetos, usando a primeira linha como cabeçalho.
function analisarCsv(texto) {
    const linhas = [];
    let linhaAtual = [];
    let campo = "";
    let dentroAspas = false;

    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        const proximo = texto[i + 1];

        if (dentroAspas) {
            if (c === '"' && proximo === '"') { campo += '"'; i++; }
            else if (c === '"') { dentroAspas = false; }
            else { campo += c; }
            continue;
        }

        if (c === '"') { dentroAspas = true; }
        else if (c === ',') { linhaAtual.push(campo); campo = ""; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && proximo === '\n') i++;
            linhaAtual.push(campo);
            campo = "";
            if (linhaAtual.some(function (v) { return v.trim() !== ""; })) {
                linhas.push(linhaAtual);
            }
            linhaAtual = [];
        } else {
            campo += c;
        }
    }
    if (campo !== "" || linhaAtual.length) {
        linhaAtual.push(campo);
        linhas.push(linhaAtual);
    }

    const cabecalho = linhas.shift().map(function (h) { return h.trim().toLowerCase(); });

    return linhas.map(function (linha) {
        const obj = {};
        cabecalho.forEach(function (chave, indice) {
            obj[chave] = (linha[indice] || "").trim();
        });
        return obj;
    });
}

// Calcula o hash SHA-256 (em hexadecimal) de um texto. Usado para comparar
// a senha digitada pelo cliente com o hash guardado na planilha, sem nunca
// manusear a senha em texto puro.
async function sha256Hex(texto) {
    const bytes = new TextEncoder().encode(texto);
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hashBuffer))
        .map(function (b) { return b.toString(16).padStart(2, "0"); })
        .join("");
}

// Extrai o ID de uma pasta a partir de um link de pasta do Google Drive.
// Aceita formatos como /drive/folders/ID, /drive/u/0/folders/ID ou ?id=ID.
function extrairIdPastaDrive(link) {
    if (!link) return null;
    let m = link.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!m) m = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
}

// Monta a URL de imagem exibível a partir do ID de um arquivo do Drive.
function urlFotoDrive(idArquivo, largura) {
    return "https://drive.google.com/thumbnail?id=" + idArquivo + "&sz=w" + (largura || 1600);
}

// Monta a URL de DOWNLOAD (arquivo original, não a miniatura) a partir do
// ID de um arquivo do Drive.
function urlDownloadDrive(idArquivo) {
    return "https://drive.google.com/uc?export=download&id=" + idArquivo;
}

// Se o link for de um ARQUIVO individual do Drive, devolve {url, download}
// prontos para exibir/baixar. Se já for um link direto normal (Cloudinary,
// etc.), usa o próprio link para as duas coisas.
function converterLinkDrive(link) {
    if (!link) return { url: link, download: link };
    let m = link.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) m = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) {
        return { url: urlFotoDrive(m[1], 1600), download: urlDownloadDrive(m[1]) };
    }
    return { url: link, download: link };
}

// Lista todas as imagens dentro de uma pasta pública do Drive, já com o
// link de exibição e o link de download de cada uma.
async function buscarFotosDaPasta(idPasta) {
    const consulta = "'" + idPasta + "' in parents and mimeType contains 'image/' and trashed = false";
    const url = "https://www.googleapis.com/drive/v3/files"
        + "?q=" + encodeURIComponent(consulta)
        + "&fields=" + encodeURIComponent("files(id,name)")
        + "&orderBy=name"
        + "&pageSize=1000"
        + "&key=" + DRIVE_API_KEY;

    const resposta = await fetch(url);
    if (!resposta.ok) {
        throw new Error("Não foi possível ler a pasta do Drive (" + resposta.status + ")");
    }

    const dados = await resposta.json();
    const arquivos = dados.files || [];
    return arquivos.map(function (arquivo) {
        return {
            url: urlFotoDrive(arquivo.id, 1600),
            download: urlDownloadDrive(arquivo.id),
            nome: arquivo.name
        };
    });
}

// Resolve a lista de fotos de UMA sessão (pasta do Drive ou links diretos)
// e preenche sessao.fotos / sessao.capa. Separado de buscarSessoes() para
// que sessões protegidas por senha só tenham as fotos buscadas depois que
// a senha certa for digitada — antes disso, nenhum link de foto passa
// pelo navegador.
async function resolverFotos(sessao) {
    if (sessao.fotos.length) return sessao.fotos; // já resolvida

    const idPasta = extrairIdPastaDrive(sessao._linkFotos);

    let fotos = [];
    if (idPasta) {
        fotos = await buscarFotosDaPasta(idPasta);
    } else {
        fotos = sessao._linkFotos.split(",")
            .map(function (f) { return f.trim(); })
            .filter(Boolean)
            .map(function (f) { return converterLinkDrive(f); });
    }

    sessao.fotos = fotos;
    if (!sessao.capa) sessao.capa = fotos[0] ? fotos[0].url : "";
    return fotos;
}

// Busca a planilha publicada e devolve a lista de sessões já tratada.
// Sessões SEM senha já vêm com as fotos resolvidas (comportamento igual a
// antes). Sessões COM senha vêm com fotos vazias — use resolverFotos(sessao)
// depois que a senha for confirmada para buscar as fotos de verdade.
async function buscarSessoes() {
    if (!SHEET_PROXY_URL || SHEET_PROXY_URL.indexOf("COLE_AQUI") !== -1) {
        throw new Error("URL do Worker não configurada em dados.js");
    }

    const resposta = await fetch(SHEET_PROXY_URL, { cache: "no-store" });
    if (!resposta.ok) {
        throw new Error("Não foi possível carregar a planilha (" + resposta.status + ")");
    }

    const texto = (await resposta.text()).replace(/^\uFEFF/, "");
    const linhas = analisarCsv(texto).filter(function (l) { return l.slug; });

    return Promise.all(linhas.map(async function (l) {
        const linkFotos = (l.fotos || "").trim();
        const senha = (l.senha || "").trim();
        const protegida = !!senha;

        const sessao = {
            slug: l.slug,
            categoria: l.categoria || "",
            categoriaHref: (l.categoria || "").toLowerCase() + ".html",
            cliente: l.cliente || "",
            titulo: l.titulo || "",
            local: l.local || "",
            data: l.data || "",
            capa: l.capa ? converterLinkDrive(l.capa).url : "",
            fotos: [],
            senha: senha,
            protegida: protegida,
            _linkFotos: linkFotos
        };

        if (!protegida) {
            try {
                await resolverFotos(sessao);
            } catch (erro) {
                console.error("Falha ao carregar as fotos da sessão \"" + sessao.slug + "\":", erro);
            }
        }

        return sessao;
    }));
}
