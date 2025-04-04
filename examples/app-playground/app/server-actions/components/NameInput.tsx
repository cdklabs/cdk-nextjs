import { InputHTMLAttributes, PropsWithChildren } from 'react';

export function NameInput(
  props?: PropsWithChildren<InputHTMLAttributes<HTMLInputElement>>,
) {
  return (
    <input name="name" placeholder="Name" className="text-black" {...props} />
  );
}
