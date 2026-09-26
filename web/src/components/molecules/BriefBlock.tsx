type BriefBlockProps = {
  text: string
}

export function BriefBlock({ text }: BriefBlockProps) {
  return <p className="brief-block">{text}</p>
}
