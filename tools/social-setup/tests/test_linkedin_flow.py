from unittest.mock import MagicMock, patch
from social_setup.platforms.linkedin import LinkedInPlatform


def test_linkedin_platform_has_name():
    assert LinkedInPlatform.name == "linkedin"


def test_linkedin_provision_returns_dict():
    platform = LinkedInPlatform()
    brand = MagicMock()
    brand.name = "America Strikes"
    brand.bio_short = "Defense and geopolitics news."
    brand.url = "https://americastrikes.com"
    brand.avatar_path = None

    mock_page = MagicMock()
    mock_page.url = "https://www.linkedin.com/in/test-user/"

    with patch.object(platform, "_do_signup", return_value={"username": "test@example.com", "url": "https://www.linkedin.com/in/test-user/"}), \
         patch.object(platform, "generate_and_store_totp", return_value="FAKETOTP32CHARSSECRETXXXXXXXXXXX"), \
         patch("social_setup.platforms.linkedin.write_creds"):
        result = platform.provision("example.com", brand, mock_page)

    assert "username" in result
    assert "linkedin.com" in result["url"]
