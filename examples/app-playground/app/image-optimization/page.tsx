import { getImageSrc } from '#/lib/image-utils';
import Image from 'next/image';
import importedLogo from './imported-logo.png';

export default function Page() {
  return (
    <div className="flex flex-col gap-y-3">
      <h1>Image Optimization</h1>
      <p>
        Regression coverage for{' '}
        <a href="https://github.com/cdklabs/cdk-nextjs/issues/260">
          cdklabs/cdk-nextjs#260
        </a>
        : imported images (<code>_next/static/media/*</code>) must optimize the
        same as <code>public/</code> images.
      </p>
      <Image
        src={getImageSrc('/static/nextjs-icon-light-background.png')}
        alt="Public image"
        width={100}
        height={100}
      />
      <Image src={importedLogo} alt="Imported image" width={100} height={100} />
      <Image
        src="https://raw.githubusercontent.com/cdklabs/cdk-nextjs/main/examples/app-playground/app/image-optimization/imported-logo.png"
        alt="Absolute URL image"
        width={100}
        height={100}
      />
    </div>
  );
}
