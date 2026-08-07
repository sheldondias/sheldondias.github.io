/*
    dados.js
    ---------
    Busca as sessões (Esportes, Eventos, Retratos) direto de uma planilha
    do Google Sheets publicada na web como CSV. Usado por esportes.html,
    eventos.html, retratos.html e galeria.html.

    COMO CONFIGURAR A PLANILHA:
    1. Crie uma planilha no Google Sheets com esta linha de cabeçalho na primeira linha:
       slug | categoria | cliente | titulo | local | data | capa | fotos

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

    2. No Google Sheets: Arquivo > Compartilhar > Publicar na web > selecione a
       aba > formato "Valores separados por vírgula (.csv)" > Publicar.
       Copie o link gerado (termina em "output=csv") e cole abaixo em SHEET_CSV_URL.

    COMO CONFIGURAR A CHAVE DO GOOGLE DRIVE (necessária para ler as pastas):
    1. Acesse console.cloud.google.com, crie um projeto (ou use um existente).
    2. Vá em "APIs e serviços" > "Biblioteca", procure "Google Drive API" e ative.
    3. Vá em "APIs e serviços" > "Credenciais" > "Criar credenciais" > "Chave de API".
    4. Copie a chave gerada e cole abaixo em DRIVE_API_KEY.
    5. (Recomendado) Restrinja a chave para funcionar só com a Google Drive API
       e só a partir do domínio do seu site, em "Restrições de aplicativo".
*/

const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1gDgdl50T0VC5pQKH-6e8MHRJk5gs7CJ3HchopIP5Hx4/export?format=csv&gid=316155775";
const DRIVE_API_KEY = "COLE_AQUI_SUA_CHAVE_DE_API_DO_GOOGLE_DRIVE";

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

// Se o link for de um ARQUIVO individual do Drive, converte para um link de
// imagem exibível. Se já for um link direto normal (Cloudinary, etc.), devolve como está.
function converterLinkDrive(link) {
    if (!link) return link;
    let m = link.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) m = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return m ? urlFotoDrive(m[1], 1600) : link;
}

// Lista todas as imagens dentro de uma pasta pública do Drive.
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
        return urlFotoDrive(arquivo.id, 1600);
    });
}

// Busca a planilha publicada e devolve a lista de sessões já tratada,
// já com as fotos de cada sessão resolvidas (pasta do Drive ou links diretos).
async function buscarSessoes() {
    if (!SHEET_CSV_URL || SHEET_CSV_URL.indexOf("COLE_AQUI") !== -1) {
        throw new Error("Link da planilha não configurado em dados.js");
    }

    const resposta = await fetch(SHEET_CSV_URL, { cache: "no-store" });
    if (!resposta.ok) {
        throw new Error("Não foi possível carregar a planilha (" + resposta.status + ")");
    }

    const texto = await resposta.text();
    const linhas = analisarCsv(texto).filter(function (l) { return l.slug; });

    return Promise.all(linhas.map(async function (l) {
        const linkFotos = (l.fotos || "").trim();
        const idPasta = extrairIdPastaDrive(linkFotos);

        let fotos = [];
        if (idPasta) {
            try {
                fotos = await buscarFotosDaPasta(idPasta);
            } catch (erro) {
                console.error("Falha ao carregar a pasta do Drive da sessão \"" + l.slug + "\":", erro);
                fotos = [];
            }
        } else {
            fotos = linkFotos.split(",")
                .map(function (f) { return converterLinkDrive(f.trim()); })
                .filter(Boolean);
        }

        const capa = converterLinkDrive(l.capa) || fotos[0] || "";

        return {
            slug: l.slug,
            categoria: l.categoria || "",
            categoriaHref: (l.categoria || "").toLowerCase() + ".html",
            cliente: l.cliente || "",
            titulo: l.titulo || "",
            local: l.local || "",
            data: l.data || "",
            capa: capa,
            fotos: fotos
        };
    }));
}
