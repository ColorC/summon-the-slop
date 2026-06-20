//! OCR via the built-in Windows.Media.Ocr — no model download; uses the user's
//! installed language packs (Chinese + English work out of the box on this box).
use std::time::Duration;

use windows::core::RuntimeType;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows_future::{AsyncStatus, IAsyncOperation};

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn block<T: RuntimeType>(op: IAsyncOperation<T>) -> Result<T, String> {
    loop {
        match op.Status().map_err(e2s)? {
            AsyncStatus::Completed => return op.GetResults().map_err(e2s),
            AsyncStatus::Started => std::thread::sleep(Duration::from_millis(2)),
            other => return Err(format!("async op failed: {other:?}")),
        }
    }
}

pub fn ocr_png(bytes: &[u8]) -> Result<String, String> {
    let stream = InMemoryRandomAccessStream::new().map_err(e2s)?;
    let out = stream.GetOutputStreamAt(0).map_err(e2s)?;
    let writer = DataWriter::CreateDataWriter(&out).map_err(e2s)?;
    writer.WriteBytes(bytes).map_err(e2s)?;
    block(writer.StoreAsync().map_err(e2s)?)?;
    block(writer.FlushAsync().map_err(e2s)?)?;
    stream.Seek(0).map_err(e2s)?;

    let decoder = block(BitmapDecoder::CreateAsync(&stream).map_err(e2s)?)?;
    let bitmap = block(decoder.GetSoftwareBitmapAsync().map_err(e2s)?)?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(e2s)?;
    let result = block(engine.RecognizeAsync(&bitmap).map_err(e2s)?)?;
    Ok(result.Text().map_err(e2s)?.to_string())
}
