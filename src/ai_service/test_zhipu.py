import os
import sys
import unittest
from unittest.mock import patch, MagicMock

# Add src/ai_service to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import main


class TestZhipuIntegration(unittest.TestCase):
    def setUp(self):
        self.reload_patch = patch("config.reload_config")
        self.reload_patch.start()
        os.environ["GLM_API_KEY"] = "test-zhipu-key-12345"
        os.environ["ZHIPU_API_KEY"] = "test-zhipu-key-12345"
        os.environ["ZHIPU_MODEL"] = "glm-5.3"
        os.environ["GLM_MODEL"] = "glm-5.3"
        os.environ["ZHIPU_VISION_MODEL"] = "glm-5.3-flash"
        os.environ["GLM_VISION_MODEL"] = "glm-5.3-flash"
        os.environ["ZHIPU_EMBEDDING_MODEL"] = "embedding-3"
        os.environ["ZHIPU_BASE_URL"] = "https://api.z.ai/api/paas/v4/"
        os.environ["GLM_BASE_URL"] = "https://api.z.ai/api/paas/v4/"

    def tearDown(self):
        self.reload_patch.stop()

    def test_config_getters(self):
        self.assertEqual(config.get_zhipu_api_key(), "test-zhipu-key-12345")
        self.assertEqual(config.get_zhipu_model(), "glm-5.3")
        self.assertEqual(config.get_zhipu_vision_model(), "glm-5.3-flash")
        self.assertEqual(config.get_zhipu_embedding_model(), "embedding-3")
        self.assertEqual(config.get_zhipu_base_url(), "https://api.z.ai/api/paas/v4/")

    def test_zhipu_client_initialization(self):
        os.environ["LLM_PROVIDER"] = "zhipu"
        client, model_name = main.get_llm_client(is_instructor=False, is_vision=False)
        self.assertEqual(model_name, "glm-5.3")
        self.assertTrue(str(client.base_url).rstrip("/").endswith("api/paas/v4"))

        vision_client, vision_model = main.get_llm_client(is_instructor=False, is_vision=True)
        self.assertEqual(vision_model, "glm-5.3-flash")

    @patch("openai.OpenAI")
    def test_zhipu_embeddings_rejects_wrong_dimension(self, mock_openai):
        mock_instance = MagicMock()
        mock_openai.return_value = mock_instance

        mock_embedding_data = MagicMock()
        mock_embedding_data.embedding = [0.1] * 1024
        mock_response = MagicMock()
        mock_response.data = [mock_embedding_data]
        mock_instance.embeddings.create.return_value = mock_response

        with self.assertRaises(ValueError) as ctx:
            main.get_zhipu_embeddings("Test Text")
        self.assertIn("1024", str(ctx.exception))
        self.assertIn("384", str(ctx.exception))

    @patch("openai.OpenAI")
    def test_zhipu_embeddings_accepts_384(self, mock_openai):
        mock_instance = MagicMock()
        mock_openai.return_value = mock_instance

        mock_embedding_data = MagicMock()
        mock_embedding_data.embedding = [0.1] * 384
        mock_response = MagicMock()
        mock_response.data = [mock_embedding_data]
        mock_instance.embeddings.create.return_value = mock_response

        vector = main.get_zhipu_embeddings("Test Text")
        self.assertEqual(len(vector), 384)
        self.assertEqual(vector[0], 0.1)

    def test_mock_fallback_when_empty_key_is_local_384(self):
        os.environ["ZHIPU_API_KEY"] = ""
        os.environ["GLM_API_KEY"] = ""
        os.environ["EMBEDDING_PROVIDER"] = "zhipu"
        with patch.object(main, "get_local_embeddings", return_value=[0.2] * 384) as local_mock:
            vector = main.get_zhipu_embeddings("Fallback Test")
            self.assertEqual(len(vector), 384)
            local_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
