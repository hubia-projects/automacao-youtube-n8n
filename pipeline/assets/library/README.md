# Biblioteca Local de Clips

Adicione clips curados manualmente aqui. O pipeline usa estes clips como **primeira fonte** antes de buscar no Pexels/Pixabay.

## Estrutura de Pastas

```
library/
  portugal/
    lisboa/
      alfama-street-walk.mp4
      alfama-street-walk.meta.json
    porto/
      ribeira-night.mp4
      francesinha-serving.meta.json
    sintra/
      palacio-pena-aerial.mp4
  generic/
    food-market-generic.mp4
```

## Formato `.meta.json`

Cada clip deve ter um `.meta.json` com o mesmo nome base:

```json
{
  "description": "Chef servindo francesinha em restaurante do Porto",
  "tags": ["francesinha", "porto", "traditional food", "portuguese cuisine"],
  "location": { "city": "porto", "country": "portugal" },
  "type": "video"
}
```

## Campos

| Campo | Descrição |
|-------|-----------|
| `description` | O que o clip mostra (usado no matching semântico) |
| `tags` | Palavras-chave para busca |
| `location.city` | Cidade no clip (minúsculas, sem acento) |
| `location.country` | País no clip — clips com país errado são **rejeitados** pelo filtro geográfico |
| `type` | `"video"` ou `"image"` |

## Como funciona

1. Para cada cena, busca clips locais primeiro por keyword/localização
2. Filtro geográfico HARD: clips de país errado são descartados
3. Deduplicação HARD: cada clip aparece no máximo 1x no vídeo
4. Só busca Pexels/Pixabay se a biblioteca local não completar o pool

## Formatos suportados

- **Vídeo:** `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`
- **Imagem:** `.jpg`, `.jpeg`, `.png`, `.webp`
