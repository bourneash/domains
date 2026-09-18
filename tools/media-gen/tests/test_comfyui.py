from media_gen import comfyui, config


def test_quality_workflow_uses_flux_dev_stack():
    graph = comfyui._quality_workflow("a paper collage", 1200, 672, 30, 123)

    assert graph["1"]["class_type"] == "UNETLoader"
    assert graph["1"]["inputs"]["unet_name"] == config.COMFYUI_DEV_MODEL
    assert graph["2"]["class_type"] == "DualCLIPLoader"
    assert graph["8"]["inputs"]["steps"] == 30
    assert graph["8"]["inputs"]["seed"] == 123


def test_fast_workflow_keeps_existing_checkpoint_path():
    graph = comfyui._fast_workflow("a workshop", "no text", 1200, 672, 4, 456)

    assert graph["4"]["class_type"] == "CheckpointLoaderSimple"
    assert graph["4"]["inputs"]["ckpt_name"] == config.COMFYUI_CHECKPOINT
    assert graph["3"]["inputs"]["steps"] == 4


def test_generate_rejects_when_local_execution_slot_stays_busy(monkeypatch):
    class BusyLock:
        def acquire(self, timeout):
            assert timeout == config.COMFYUI_LOCK_WAIT_S
            return False

        def locked(self):
            return True

    monkeypatch.setattr(comfyui, "_GENERATION_LOCK", BusyLock())

    try:
        comfyui.generate("a workshop")
    except comfyui.ComfyUIBusyError as error:
        assert "retry shortly" in str(error)
    else:
        raise AssertionError("expected ComfyUIBusyError")
