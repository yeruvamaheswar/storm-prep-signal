import { Button } from "../atoms/Button"

type ControlProps = {
  name: string
  pressed?: boolean
  armed?: boolean
  onClick: () => void
}

export function Control({ name, pressed = false, armed = false, onClick }: ControlProps) {
  return (
    <div className="control">
      <Button pressed={pressed} armed={armed} onClick={onClick} label={name}>
        {name}
      </Button>
    </div>
  )
}
