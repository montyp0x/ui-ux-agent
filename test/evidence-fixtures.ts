import type { Page } from 'playwright';

// Counts strongly red pixels (the planted secret's colour) and mask-coloured
// pixels in a PNG, by decoding it in the browser.
export async function pixelCounts(
  page: Page,
  png: Buffer,
): Promise<{ red: number; mask: number }> {
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let red = 0;
    let mask = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const [r, g, b] = [
        pixels[index]!,
        pixels[index + 1]!,
        pixels[index + 2]!,
      ];
      if (r > 200 && g < 60 && b < 60) red++;
      if (r > 240 && g < 20 && b > 240) mask++;
    }
    return { red, mask };
  }, png.toString('base64'));
}
