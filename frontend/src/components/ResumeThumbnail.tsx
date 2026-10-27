import { useState } from 'react';

/** Inspect saved images locally; this never requests a new resume from BOSS. */
export function ResumeThumbnail({ src, name, onPreview }: { src: string; name: string; onPreview: () => void }) {
  const [problem, setProblem] = useState('');
  return <div className="resume-thumbnail-status">
    <button className="resume-thumbnail" aria-label={`查看${name}的在线简历截图`} onClick={onPreview}>
      <img src={src} alt={`${name}的在线简历截图`} loading="lazy" crossOrigin="anonymous" onError={() => setProblem('图片加载失败')} onLoad={event => {
        const image = event.currentTarget;
        try {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 600 / image.naturalWidth, 6000 / image.naturalHeight);
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) { setProblem('图片未能检查'); return; }
          context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          let ink = 0;
          for (let i = 0; i < data.length; i += 4) if (data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722 < 180) ink++;
          setProblem(ink < Math.max(16, canvas.width * canvas.height * .0002) ? '疑似空白' : '');
        } catch { setProblem('图片未能检查'); }
      }} />
    </button>
    {problem && <span className="resume-image-warning" title="可点击右侧重新读取补拍">{problem}</span>}
  </div>;
}
