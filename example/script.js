const picker = document.getElementById('picker');
const loc = document.getElementById('location');
const vid = document.getElementById('myVideo');

if (picker) {
  picker.onchange = () => {
    const endpoint = document.getElementById('location').value;
    const file = picker.files[0];

    const upload = UpChunk.createUpload({
      endpoint,
      mimeType: file.type,
      maxChunkSize: 5120,
    });

    upload.on('error', err => {
      console.error('It all went wrong!', err.detail);
    });

    upload.on('progress', ({ detail: progress }) => {
      console.log(`Progress: ${progress}%`);
    });

    upload.on('attempt', ({ detail }) => {
      console.log('There was an attempt!', detail);
    });

    upload.on('success', () => {
      console.log('We did it!');
    });
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result !== null) {
        const chunk = new Blob([reader.result], {
          type: file.type,
        });
        upload.addChunk(chunk)
        upload.finish()
      }
    };
    reader.readAsArrayBuffer(file);
  };
}

if (vid) {
  const options = {
    controls: true,
    bigPlayButton: false,
    width: 640,
    height: 480,
    fluid: false,
    plugins: {
      record: {
        audio: true,
        video: true,
        maxLength: 60,
        debug: true,
        timeSlice: 1000
      }
    }
  };

  let lastIndex = 0
  const player = videojs('myVideo', options);

  player.on('deviceError', function() {
      console.log('device error:', player.deviceErrorCode);
  });

  player.on('error', function(element, error) {
      console.error(error);
  });

  player.on('startRecord', function() {
    recording = true
    console.time("upload");
    console.log('started recording!');
  });

  player.on('timestamp', function() {
    const totalLength = player.recordedData.length
    const blob = new Blob(player.recordedData.slice(lastIndex, totalLength))
    getUploader().addChunk(blob)
    lastIndex = totalLength
  })

  player.on('finishRecord', function() {
    getUploader().finish()
    console.log('finished recording: ', player);
  });

  let upload;
  const getUploader = () => {
    if (upload) return upload
    upload = UpChunk.createUpload({
      endpoint: () => new Promise((resolve) => {
        if (loc.value.length > 0) {
          return resolve(loc.value)
        }
        loc.onchange = () => {
          console.log('loc', loc.value)
          resolve(loc.value)
        }
      }),
      maxChunkSize: 51200,
    });
    upload.on('error', err => {
      console.error('It all went wrong!', err.detail);
    });

    upload.on('progress', ({ detail: progress }) => {
      console.log(`Progress: ${progress}%`);
    });

    upload.on('attempt', ({ detail }) => {
      console.log('There was an attempt!', detail);
    });

    upload.on('success', () => {
      console.timeEnd("upload");
      console.log('We did it!');
    });
    return upload
  }
}
