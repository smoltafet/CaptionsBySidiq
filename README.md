CaptionBySide is a generator specifically for the Persian language. The captions generator takes a video, transcribes it to Persian and than applies captions on the video. The captions can be adjustable with a nice editor and you have options like colors, margins, etc. 

Bellow is the flow diagram for the project. 
I built the project from scratch using Next.JS 13, React, Tailwind.css and WebAssembly. For storage I used an AWS S3 bucket and for transcription we I used an AWS Transcribe service. 

Note: To enhance the video generation by AWS Transcribe I used Cohere API generation to first "go-over" users video to accuratly transcibe points in which AWS Transribe would not be able to detect. 

<img width="299" alt="Flow Diagram Caption Sidiq" src="https://github.com/smoltafet/CaptionsBySidiq/assets/109406581/e7a04a78-ec75-4572-abb9-0cba0f85d176">




