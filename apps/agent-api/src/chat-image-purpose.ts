/** A pass-through logo upload needs the filename and bytes in storage, without visual model inference. */
export function inferenceImagesForRequest<T>(message: string, images: T[]): T[] {
  const logo = /\b(?:logo|logotipo)\b|логотип/iu.test(message);
  const assign = /\b(?:set|use|upload|attach|assign|define|usar|subir|establece|definir|anexar|hochladen|verwende|festlegen)\b|встанов|прикріп|завантаж|використ/iu.test(message);
  const analyze = /\b(?:analy[sz]e|describe|read|identify|compare|extract|recreate|design|analysieren|beschreib|analiza|describ|analis|descrev)\w*|аналіз|опиши|прочитай|порівня|відтвор/iu.test(message);
  return logo && assign && !analyze ? [] : images;
}
