import pytest

from studio.library.licenses import LicenseError, validate_license


def test_pexels_valido():
    rec = validate_license({"source": "pexels", "source_url": "https://pexels.com/v/1",
                            "license": "pexels"})
    assert rec.retrieved_at  # autopreenchido
    assert not rec.attribution_required


def test_sem_licenca_rejeitado():
    with pytest.raises(LicenseError):
        validate_license({"source": "pexels", "source_url": "x"})  # falta license


def test_licenca_errada_para_fonte():
    with pytest.raises(LicenseError):
        validate_license({"source": "pexels", "source_url": "x", "license": "cc-by"})


def test_cc_by_exige_atribuicao():
    with pytest.raises(LicenseError, match="attribution_text"):
        validate_license({"source": "wikimedia", "source_url": "x", "license": "cc-by"})
    rec = validate_license({"source": "wikimedia", "source_url": "x", "license": "cc-by",
                            "attribution_text": "Foto de X, CC-BY 4.0"})
    assert rec.attribution_required


def test_cc_by_sa_marca_restricted():
    rec = validate_license({"source": "wikimedia", "source_url": "x", "license": "cc-by-sa",
                            "attribution_text": "y"})
    assert rec.share_alike  # → restricted na biblioteca


def test_youtube_cc_exige_verificacao_manual():
    with pytest.raises(LicenseError, match="manual"):
        validate_license({"source": "youtube_cc", "source_url": "x", "license": "cc-by",
                          "attribution_text": "y", "verified_by": "api"})


def test_fonte_desconhecida_rejeitada():
    with pytest.raises(LicenseError):
        validate_license({"source": "instagram", "source_url": "x", "license": "cc0"})
